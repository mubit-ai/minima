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
import { BudgetLedger } from "../src/minima/budget.ts";
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
  cost: { input: 1000, output: 2000 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function capturingService() {
  const recommendCalls: string[] = [];
  const feedbackCalls: string[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ?? "");
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            est_cost_high: 0.002,
            score: 0.001,
          },
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "qa",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ?? "");
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, recommendCalls, feedbackCalls };
}

function buildAgent(svc: ReturnType<typeof capturingService>): MinimaAgent {
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
}

describe("one-turn pin (picker ⏎ → promptRouted pinModel)", () => {
  test("a pinModel turn never touches the server and sends no feedback", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const svc = capturingService();
    const agent = buildAgent(svc);
    const routing = await agent.promptRouted("hi", { pinModel: FAUX_MODEL });

    expect(svc.recommendCalls).toHaveLength(0); // pre-request assembly, not a re-rank
    expect(svc.feedbackCalls).toHaveLength(0); // propensity integrity: pinned turns teach nothing
    expect(routing?.decisionBasis).toBe("pinned");
    expect(routing?.recommendationId).toBeNull();
    expect(agent.agentState.model?.id).toBe("test-faux");
    reg.unregister();
  });

  test("routing resumes on the very next prompt", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("one")] }),
      new AssistantMessage({ content: [text("two")] }),
    ]);

    const svc = capturingService();
    const agent = buildAgent(svc);
    await agent.promptRouted("first", { pinModel: FAUX_MODEL });
    expect(svc.recommendCalls).toHaveLength(0);

    const second = await agent.promptRouted("second");
    expect(svc.recommendCalls).toHaveLength(1); // the pin lasted exactly one turn
    expect(second?.decisionBasis).toBe("memory");
    expect(second?.recommendationId).toBe("rec-1");
    reg.unregister();
  });

  test("one-shot spend reaches the ledger via reserve/reconcile — never a double book", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const svc = capturingService();
    const agent = buildAgent(svc);
    const runId = db.startRun({ projectKey: "p" });
    agent.db = db;
    agent.runId = runId;
    agent.budget = new BudgetLedger({ db, scopeKey: `session:${runId}`, limitUsd: 5, runId });
    await agent.promptRouted("pinned once", { pinModel: FAUX_MODEL });

    const s = agent.budget.status();
    expect(s.spentUsd).toBeGreaterThan(0);
    expect(s.spentUsd).toBeCloseTo(agent.meter!.totals().actualCostUsd, 8);
    const kinds = db.db
      .query("SELECT kind FROM budget_events WHERE scope_key = ?1 ORDER BY ts")
      .all(`session:${runId}`) as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toContain("reserve");
    expect(kinds.map((k) => k.kind)).toContain("reconcile");
    expect(kinds.map((k) => k.kind)).not.toContain("book");
    reg.unregister();
    db.close();
  });

  test("the decision row records the one-shot turn as pinned, not server-routed", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const svc = capturingService();
    const agent = buildAgent(svc);
    const runId = db.startRun({ projectKey: "p" });
    agent.db = db;
    agent.runId = runId;
    await agent.promptRouted("hi", { pinModel: FAUX_MODEL });

    const rows = db.db
      .query("SELECT routed, chosen_model FROM routing_decisions WHERE run_id = ?1")
      .all(runId) as { routed: string; chosen_model: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routed).toBe("pinned");
    expect(rows[0]!.chosen_model).toBe("test-faux");
    reg.unregister();
    db.close();
  });
});
