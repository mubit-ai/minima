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
import { type BudgetEvent, BudgetLedger } from "../src/minima/budget.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1000, output: 2000 }, // pricey so realized cost is non-trivial
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

/** A recommend endpoint that always fails the given way; feedback accepts (never reached). */
function failingService(recommend: { status: number; body: Record<string, unknown> }) {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return { status: recommend.status, json: async () => recommend.body };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return fetchLike;
}

const INFEASIBLE_422 = {
  status: 422,
  body: {
    type: "about:blank",
    title: "No candidate models",
    status: 422,
    detail: "no model within max_cost_per_call budget",
  },
};

const OUTAGE_500 = { status: 500, body: { detail: "minima is down" } };

function offlineAgent(
  db: MinimaDb,
  limitUsd: number,
  mode: "warn" | "enforce",
  recommend: { status: number; body: Record<string, unknown> },
  events?: BudgetEvent[],
): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: failingService(recommend) });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: true,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  const runId = db.startRun({ projectKey: "p" });
  agent.db = db;
  agent.runId = runId;
  agent.budget = new BudgetLedger({
    db,
    scopeKey: `session:${runId}`,
    limitUsd,
    mode,
    runId,
    onEvent: events ? (e) => events.push(e) : undefined,
  });
  return agent;
}

function bookEvents(db: MinimaDb, scopeKey: string): { kind: string; note: string | null }[] {
  return db.db
    .query("SELECT kind, note FROM budget_events WHERE scope_key = ?1 ORDER BY ts")
    .all(scopeKey) as { kind: string; note: string | null }[];
}

describe("budget on unrouted turns (F1)", () => {
  test("an offline (unrouted) run books realized spend into the ledger", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 5, "warn", OUTAGE_500);
    const routing = await agent.promptRouted("do something");
    expect(routing).toBeNull(); // ran unrouted

    const s = agent.budget!.status();
    expect(s.spentUsd).toBeGreaterThan(0);
    expect(s.spentUsd).toBeCloseTo(agent.meter!.totals().actualCostUsd, 8);
    const booked = bookEvents(db, `session:${agent.runId}`).filter((e) => e.kind === "book");
    expect(booked).toHaveLength(1);
    expect(booked[0]!.note ?? "").toStartWith("unrouted:");
    reg.unregister();
    db.close();
  });

  test("threshold warnings fire from unrouted spend alone", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const big = new AssistantMessage({ content: [text("ok")] });
    big.usage.input = 10; // $0.01 + $0.02 = $0.03 realized — blows a $0.02 cap
    big.usage.output = 10;
    reg.setResponses([big]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const events: BudgetEvent[] = [];
    const agent = offlineAgent(db, 0.02, "warn", OUTAGE_500, events);
    await agent.promptRouted("expensive unrouted turn");

    const thresholds = events.filter((e) => e.kind === "threshold").map((e) => e.note ?? "");
    expect(thresholds).toHaveLength(4); // 50/75/90/100 all crossed by the one booked run
    expect(thresholds[0]).toContain("50%");
    expect(agent.budget!.exhausted()).toBe(true);
    reg.unregister();
    db.close();
  });

  test("enforce: unrouted overspend arms the pre-spend gate for the next prompt", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const first = new AssistantMessage({ content: [text("first")] });
    first.usage.input = 10;
    first.usage.output = 10;
    reg.setResponses([first, new AssistantMessage({ content: [text("never sent")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 0.004, "enforce", OUTAGE_500);
    await agent.promptRouted("first"); // unrouted, spends past the cap
    expect(agent.budget!.exhausted()).toBe(true);

    await expect(agent.promptRouted("second")).rejects.toThrow(/budget exhausted/);
    expect(reg.state.pendingResponseCount).toBe(1); // second response never consumed
    reg.unregister();
    db.close();
  });

  test("enforce: budget-infeasible routing refuses the turn — no offline fallback", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("never sent")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 5, "enforce", INFEASIBLE_422); // plenty of headroom
    await expect(agent.promptRouted("hi")).rejects.toThrow(/no candidate fits|max_cost_per_call/);

    expect(reg.state.pendingResponseCount).toBe(1); // nothing ran
    const s = agent.budget!.status();
    expect(s.spentUsd).toBeCloseTo(0, 8);
    expect(s.reservedUsd).toBeCloseTo(0, 8);
    reg.unregister();
    db.close();
  });

  test("warn: budget-infeasible routing runs unrouted but books spend with an honest reason", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 5, "warn", INFEASIBLE_422);
    const routing = await agent.promptRouted("hi");
    expect(routing).toBeNull();

    expect(agent.offlineKind).toBe("budget");
    expect(agent.offlineReason ?? "").toContain("max_cost_per_call");
    const s = agent.budget!.status();
    expect(s.spentUsd).toBeGreaterThan(0);
    const booked = bookEvents(db, `session:${agent.runId}`).filter((e) => e.kind === "book");
    expect(booked[0]!.note ?? "").toContain("unrouted");
    reg.unregister();
    db.close();
  });

  test("a genuine outage classifies as unreachable, not budget", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 5, "warn", OUTAGE_500);
    await agent.promptRouted("hi");
    expect(agent.offlineKind).toBe("unreachable");
    reg.unregister();
    db.close();
  });

  test("pinned turns keep booking via reserve/reconcile (no double-booking)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const agent = offlineAgent(db, 5, "warn", OUTAGE_500);
    agent.config.pinned = true; // route() short-circuits before the failing recommend
    await agent.promptRouted("pinned turn");

    const s = agent.budget!.status();
    expect(s.spentUsd).toBeGreaterThan(0);
    expect(s.spentUsd).toBeCloseTo(agent.meter!.totals().actualCostUsd, 8);
    const kinds = bookEvents(db, `session:${agent.runId}`).map((e) => e.kind);
    expect(kinds).toContain("reserve");
    expect(kinds).toContain("reconcile");
    expect(kinds).not.toContain("book"); // reconciled spend must not book twice
    reg.unregister();
    db.close();
  });
});
