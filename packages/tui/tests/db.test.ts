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
import { MinimaDb, newId } from "../src/db/minima_db.ts";
import { applyRehydratedRun, rehydrateRun } from "../src/db/rehydrate.ts";
import { attachDbSink } from "../src/db/sink.ts";
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
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function mockService() {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${Math.random().toString(16).slice(2, 8)}`,
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            est_cost_low: 0.0005,
            est_cost_high: 0.002,
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
            {
              model_id: "big-model",
              provider: "faux",
              predicted_success: 0.95,
              est_cost_usd: 0.02,
              score: 0.02,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: "easy",
          selection_policy: "argmin",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike };
}

function agentWith(db: MinimaDb, runId: string): MinimaAgent {
  const { fetchLike } = mockService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
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
  agent.db = db;
  agent.runId = runId;
  return agent;
}

describe("MinimaDb schema + lifecycle", () => {
  test("migrates to the latest schema with all core tables", () => {
    const db = new MinimaDb(":memory:");
    // v1 spine + v2 budgets/provenance + v3 plans + v4 file_changes + v5 verification
    // + v6 gate identity (rec_id/session_id/agent_id + closed_at/verify_cwd/note)
    // + v7 plan_steps.check_origin
    // + v8 plan_steps.tools (A6 per-step tool allowlist)
    expect(db.schemaVersion).toBe(8);
    for (const t of [
      "projects",
      "runs",
      "events",
      "routing_decisions",
      "tool_calls",
      "budgets",
      "budget_events",
      "plans",
      "plan_steps",
      "file_changes",
      "gates",
      "user_signals",
    ]) {
      expect(db.db.query(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    db.close();
  });

  test("run lifecycle: start → name → finish; degraded is sticky", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("proj", "ns");
    const runId = db.startRun({
      projectKey: "proj",
      providerSessionId: "sess-1",
      gitBaseSha: "abc",
    });
    db.setRunName(runId, "fix the flaky test");
    expect(db.getRun(runId)?.display_name).toBe("fix the flaky test"); // survives reload
    db.markDegraded(runId);
    db.finishRun(runId, "done");
    expect(db.getRun(runId)?.status).toBe("degraded"); // done never masks degraded
    db.close();
  });

  test("writeDecision is idempotent on rec_id (retry updates, never duplicates)", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const base = {
      recId: "rec-1",
      runId,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "memory",
      confidence: 0.8,
      thresholdUsed: 0.5,
      ranked: [{ modelId: "m", estCostUsd: 0.001 }],
      estCostUsd: 0.001,
      actualCostUsd: 0.001,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 10,
    };
    db.writeDecision(base);
    db.writeDecision({ ...base, actualCostUsd: 0.002, quality: 0.9, judged: true });
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actual_cost_usd).toBe(0.002);
    expect(rows[0]!.judged).toBe(1);
    db.close();
  });
});

describe("DecisionRecord writer (promptRouted)", () => {
  test("gate: one decision row per routed prompt, with ranked[] + all-premium anchor", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")] }),
      new AssistantMessage({ content: [text("two")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);

    await agent.promptRouted("first task");
    await agent.promptRouted("second task", { difficulty: "hard" });

    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(2); // == number of prompts
    for (const row of rows) {
      expect(String(row.rec_id)).toStartWith("rec-");
      expect(JSON.parse(String(row.ranked)).length).toBe(2);
      expect(row.all_premium_cost_usd).toBe(0.02); // max over ranked est
      expect(row.routed).toBe("server");
      expect(row.judged).toBe(1); // ConstJudge(0.9) grades every prompt
      expect(row.quality).toBe(0.9);
      expect(row.task_type).toBe("code"); // server-classified
    }
    // The routing event exists and links.
    const routingEvents = db.getRunEvents(runId).filter((e) => e.type === "routing");
    expect(routingEvents).toHaveLength(2);
    reg.unregister();
    db.close();
  });

  test("pinned run writes a synthetic local row labeled 'pinned'", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    agent.config.pinned = true;
    agent.config.candidates = ["test-faux"];

    await agent.promptRouted("pinned task");
    const rows = db.getRunDecisions(runId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.rec_id)).toStartWith("local-"); // never the hosted join key
    expect(rows[0]!.routed).toBe("pinned");
    reg.unregister();
    db.close();
  });
});

describe("DbSink", () => {
  test("persists conversation events with correlated tool names (never placeholders)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    const sink = attachDbSink(agent, db, { runId });

    await agent.promptRouted("hello");
    sink.detach();

    const events = db.getRunEvents(runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types).toContain("routing");
    const assistant = events.find((e) => e.type === "assistant")!;
    expect(JSON.parse(assistant.payload).text).toBe("answer");
    expect(sink.degraded).toBe(false);
    reg.unregister();
    db.close();
  });
});

describe("rehydration (P1c)", () => {
  test("round-trip: resume restores context, cost footer, and judge cadence", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("first answer")] }),
      new AssistantMessage({ content: [text("second answer")] }),
    ]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    const agent = agentWith(db, runId);
    const sink = attachDbSink(agent, db, { runId });
    await agent.promptRouted("task one");
    await agent.promptRouted("task two");
    sink.detach();
    db.setRunName(runId, "my run");

    // A fresh agent (new process) resumes the run.
    const agent2 = agentWith(db, db.startRun({ projectKey: "p" }));
    const r = rehydrateRun(db, runId);
    applyRehydratedRun(agent2, r);

    expect(r.run.display_name).toBe("my run"); // /name survives reload
    expect(agent2.agentState.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(agent2.agentState.messages[1]!.textContent).toBe("first answer");
    // Cost footer restored — NOT zeroed.
    expect(agent2.meter!.rows).toHaveLength(2);
    expect(agent2.meter!.totals().actualCostUsd).toBeGreaterThan(0);
    expect(r.promptsRun).toBe(2);
    reg.unregister();
    db.close();
  });

  test("sub-agent rows stay out of the lead conversation", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.appendEvent({ runId, type: "user", payload: { role: "user", text: "lead" } });
    db.appendEvent({
      runId,
      agentId: "child-1",
      type: "assistant",
      payload: { role: "assistant", text: "child noise" },
    });
    const r = rehydrateRun(db, runId);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.textContent).toBe("lead");
    db.close();
  });

  test("resume lineage: parent_run_id recorded, rec_ids never duplicated", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const a = db.startRun({ projectKey: "p" });
    const b = db.startRun({ projectKey: "p" });
    db.setRunParent(b, a);
    expect(db.getRun(b)?.parent_run_id).toBe(a);
    // rec_id is a PK: writing the same id under another run updates, never duplicates.
    const base = {
      recId: "rec-x",
      runId: a,
      taskLabel: "t",
      chosenModel: "m",
      decisionBasis: "memory",
      confidence: 0.5,
      thresholdUsed: 0.5,
      ranked: [],
      estCostUsd: 0,
      actualCostUsd: 0,
      quality: null,
      judged: false,
      outcome: "success",
      turns: 1,
      latencyMs: 1,
    };
    db.writeDecision(base);
    db.writeDecision({ ...base, runId: b });
    expect(db.getRunDecisions(a)).toHaveLength(1);
    expect(db.getRunDecisions(b)).toHaveLength(0); // conflict-update keeps the original run
    db.close();
  });
});

describe("identity", () => {
  test("run_id is DB-owned; provider session id is a plain column", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p", providerSessionId: "prompt-cache-key" });
    expect(runId).not.toBe("prompt-cache-key");
    expect(db.getRun(runId)?.provider_session_id).toBe("prompt-cache-key");
    expect(newId()).not.toBe(newId());
    db.close();
  });
});
