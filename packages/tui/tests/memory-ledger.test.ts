import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
} from "../src/ai/index.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  buildMemoryProjection,
  harnessConfig,
} from "../src/minima/index.ts";

// B1 memory ledger: DB round-trip + audit events, projection ranking/cap, and the runtime
// injection path (lead-only, per-turn, inject event recorded once per distinct set). Hermetic.

function freshDb(): MinimaDb {
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  return db;
}

function seed(db: MinimaDb, over: Partial<Parameters<MinimaDb["insertMemory"]>[0]> = {}): string {
  return db.insertMemory({
    projectKey: "proj",
    kind: "lesson",
    content: "run bun test before pushing",
    evidenceSource: "none",
    origin: "user",
    status: "active",
    ...over,
  });
}

describe("memory ledger — DB", () => {
  test("insert round-trips and writes an `add` audit event", () => {
    const db = freshDb();
    const id = seed(db, { citations: ["rec-1"], trigger: "before any push" });
    const row = db.getMemory(id)!;
    expect(row.project_key).toBe("proj");
    expect(row.kind).toBe("lesson");
    expect(row.status).toBe("active");
    expect(row.trigger).toBe("before any push");
    expect(JSON.parse(row.citations!)).toEqual(["rec-1"]);
    expect(row.invalidated_at).toBeNull();
    const events = db.listMemoryEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe("add");
    expect(events[0]!.actor).toBe("user");
  });

  test("status transitions audit their op; invalidated rows are immutable tombstones", () => {
    const db = freshDb();
    const id = seed(db, { status: "pending" });
    expect(db.setMemoryStatus(id, "active", "user")).toBe(true);
    expect(db.setMemoryStatus(id, "pinned", "user")).toBe(true);
    expect(db.invalidateMemory(id, "user")).toBe(true);
    expect(db.getMemory(id)!.status).toBe("invalidated");
    expect(db.getMemory(id)!.invalidated_at).not.toBeNull();
    // Never DELETE; further mutation refused; invalidate is idempotent.
    expect(db.setMemoryStatus(id, "active", "user")).toBe(false);
    expect(db.invalidateMemory(id, "user")).toBe(false);
    const ops = db.listMemoryEvents(id).map((e) => e.op);
    expect(ops).toEqual(["add", "confirm", "pin", "invalidate"]);
  });

  test("listMemories hides invalidated rows unless asked", () => {
    const db = freshDb();
    const keep = seed(db);
    const gone = seed(db, { content: "obsolete" });
    db.invalidateMemory(gone, "user");
    expect(db.listMemories("proj").map((r) => r.id)).toEqual([keep]);
    expect(db.listMemories("proj", { includeInvalidated: true })).toHaveLength(2);
  });

  test("findMemoryByPrefix: exact, unique prefix, ambiguous → null, short → null", () => {
    const db = freshDb();
    const a = db.insertMemory({
      id: "aaaa1111-x",
      projectKey: "proj",
      kind: "note",
      content: "a",
      evidenceSource: "human",
      origin: "user",
    });
    db.insertMemory({
      id: "aaaa2222-y",
      projectKey: "proj",
      kind: "note",
      content: "b",
      evidenceSource: "human",
      origin: "user",
    });
    expect(db.findMemoryByPrefix("proj", a)?.id).toBe(a);
    expect(db.findMemoryByPrefix("proj", "aaaa1")?.id).toBe(a);
    expect(db.findMemoryByPrefix("proj", "aaaa")).toBeNull(); // ambiguous
    expect(db.findMemoryByPrefix("proj", "aaa")).toBeNull(); // too short
  });
});

describe("memory ledger — projection", () => {
  test("empty project → null (zero overhead on cold start)", () => {
    expect(buildMemoryProjection(freshDb(), "proj")).toBeNull();
  });

  test("only active + pinned live rows project; pinned > gate-cited > recency", () => {
    const db = freshDb();
    const recent = seed(db, { content: "recent plain note" });
    const gate = seed(db, { content: "gate-backed lesson", evidenceSource: "gate" });
    const pinned = seed(db, { content: "pinned rule", status: "pinned" });
    seed(db, { content: "still pending", status: "pending" });
    seed(db, { content: "was rejected", status: "rejected" });
    const dead = seed(db, { content: "was deleted" });
    db.invalidateMemory(dead, "user");

    const proj = buildMemoryProjection(db, "proj")!;
    expect(proj.ids).toEqual([pinned, gate, recent]);
    expect(proj.text).toContain("pinned rule");
    expect(proj.text).toContain("gate-backed lesson");
    expect(proj.text).not.toContain("still pending");
    expect(proj.text).not.toContain("was rejected");
    expect(proj.text).not.toContain("was deleted");
    expect(proj.dropped).toBe(0);
  });

  test("hard cap drops whole entries (never truncates) and says how many", () => {
    const db = freshDb();
    const big = "x".repeat(300);
    const first = seed(db, { content: big, status: "pinned" });
    seed(db, { content: big });
    seed(db, { content: big });
    const proj = buildMemoryProjection(db, "proj", 520)!;
    expect(proj.ids).toEqual([first]);
    expect(proj.dropped).toBe(2);
    expect(proj.text).toContain("(2 more not shown — /memory list)");
  });

  test("a trigger renders inline as the surfacing condition", () => {
    const db = freshDb();
    seed(db, { content: "use uv, never pip", trigger: "python dependency work" });
    const proj = buildMemoryProjection(db, "proj")!;
    expect(proj.text).toContain("use uv, never pip (when: python dependency work)");
  });
});

// ---------------------------------------------------------------- runtime injection

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 0.001,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if (method === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike };
}

function setupAgent(over: Partial<ReturnType<typeof harnessConfig>> = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX);
  const reg = registerFauxProvider([FAUX]);
  const { fetchLike } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: false,
    ...over,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const db = new MinimaDb(":memory:");
  db.ensureProject("proj");
  const runId = db.startRun({ projectKey: "proj" });
  const agent = new MinimaAgent({ config, router, meter: new CostMeter(), tools: [] });
  agent.db = db;
  agent.runId = runId;
  return { agent, reg, db, runId };
}

const reply = () => new AssistantMessage({ content: [text("ok")], stop_reason: "endTurn" });

describe("memory ledger — runtime injection", () => {
  test("active memory reaches the model's system prompt; inject audited once per set", async () => {
    const { agent, reg, db, runId } = setupAgent();
    seed(db, { content: "always run bun test before pushing" });
    reg.setResponses([reply(), reply()]);

    await agent.promptRouted("first");
    const seen = reg.state.requests.at(-1)?.systemPrompt ?? "";
    expect(seen).toContain("# Memory (curated notes");
    expect(seen).toContain("always run bun test before pushing");
    // Per-turn append is reverted — never leaks into persistent state.
    expect(agent.agentState.systemPrompt ?? "").not.toContain("# Memory");

    // Same set on the second prompt → still injected, but audited only once.
    await agent.promptRouted("second");
    expect(reg.state.requests.at(-1)?.systemPrompt ?? "").toContain("# Memory");
    const injects = db.listMemoryEvents(null).filter((e) => e.op === "inject");
    expect(injects).toHaveLength(1);
    const payload = JSON.parse(injects[0]!.payload ?? "{}");
    expect(payload.run_id).toBe(runId);
    expect(payload.memory_ids).toHaveLength(1);
  });

  test("a changed memory set re-records the inject audit", async () => {
    const { agent, reg, db } = setupAgent();
    seed(db, { content: "note one" });
    reg.setResponses([reply(), reply()]);
    await agent.promptRouted("first");
    seed(db, { content: "note two" });
    await agent.promptRouted("second");
    expect(db.listMemoryEvents(null).filter((e) => e.op === "inject")).toHaveLength(2);
  });

  test("MINIMA_TUI_MEMORY=0 path: no injection, no audit", async () => {
    const { agent, reg, db } = setupAgent({ memoryLedger: false });
    seed(db, { content: "should stay invisible" });
    reg.setResponses([reply()]);
    await agent.promptRouted("go");
    expect(reg.state.requests.at(-1)?.systemPrompt ?? "").not.toContain("# Memory");
    expect(db.listMemoryEvents(null)).toHaveLength(0);
  });

  test("sub-agents are quarantined — no memory block in a child's context", async () => {
    const { agent, reg, db } = setupAgent();
    seed(db, { content: "lead-only context" });
    agent.agentId = "child-1";
    reg.setResponses([reply()]);
    await agent.promptRouted("child task");
    expect(reg.state.requests.at(-1)?.systemPrompt ?? "").not.toContain("# Memory");
    expect(db.listMemoryEvents(null)).toHaveLength(0);
  });
});
