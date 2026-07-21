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

// Two models so a cancel's incumbent-restore is observable: FAUX_A is the cheap default
// incumbent, the mock service always recommends FAUX_B.
const FAUX_A: Model = {
  id: "faux-a",
  provider: "faux",
  api: "faux",
  name: "Faux A",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const FAUX_B: Model = { ...FAUX_A, id: "faux-b", name: "Faux B", cost: { input: 10, output: 20 } };

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function capturingService(recommend?: { status: number; body: Record<string, unknown> }) {
  const feedbackCalls: string[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      if (recommend) return { status: recommend.status, json: async () => recommend.body };
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "faux-b",
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
  return { fetchLike, feedbackCalls };
}

function buildAgent(
  svc: { fetchLike: (url: string, init?: { method?: string; body?: string }) => unknown },
  cfg: Partial<Parameters<typeof harnessConfig>[0]> = {},
  agentOpts: { judge?: ConstJudge; recoveryRungs?: number } = {},
): MinimaAgent {
  const client = new MinimaClient({
    baseUrl: "http://svc.local",
    fetch: svc.fetchLike as never,
  });
  const config = harnessConfig({
    candidates: ["faux-a", "faux-b"],
    allowOffline: false,
    minimaApiKey: "k",
    ...cfg,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  return new MinimaAgent({
    config,
    router,
    judge: agentOpts.judge ?? new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
    recoveryRungs: agentOpts.recoveryRungs,
  });
}

describe("route-confirm gate (Ctrl+R consumer)", () => {
  test("cancel: no model call, no spend, no feedback, incumbent model restored", async () => {
    resetAll();
    registerModel(FAUX_A);
    registerModel(FAUX_B);
    const reg = registerFauxProvider([FAUX_A, FAUX_B]);
    reg.setResponses([new AssistantMessage({ content: [text("never sent")] })]);

    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const svc = capturingService();
    const agent = buildAgent(svc);
    const runId = db.startRun({ projectKey: "p" });
    agent.db = db;
    agent.runId = runId;
    agent.budget = new BudgetLedger({ db, scopeKey: `session:${runId}`, limitUsd: 5, runId });
    expect(agent.agentState.model?.id).toBe("faux-a"); // cheap default incumbent

    agent.confirmRun = async () => false;
    await expect(agent.promptRouted("hi")).rejects.toThrow(/cancel/);

    expect(reg.state.pendingResponseCount).toBe(1); // nothing ran
    expect(svc.feedbackCalls).toHaveLength(0);
    const s = agent.budget.status();
    expect(s.spentUsd).toBeCloseTo(0, 8);
    expect(s.reservedUsd).toBeCloseTo(0, 8);
    expect(agent.agentState.model?.id).toBe("faux-a"); // route()'s swap to faux-b undone
    reg.unregister();
    db.close();
  });

  test("accept: the routed turn runs and feeds back as usual", async () => {
    resetAll();
    registerModel(FAUX_A);
    registerModel(FAUX_B);
    const reg = registerFauxProvider([FAUX_A, FAUX_B]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const svc = capturingService();
    const agent = buildAgent(svc);
    const seen: unknown[] = [];
    agent.confirmRun = async (info) => {
      seen.push(info);
      return true;
    };
    const routing = await agent.promptRouted("hi");

    expect(routing?.chosenModelId).toBe("faux-b");
    expect(reg.state.pendingResponseCount).toBe(0);
    expect(svc.feedbackCalls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const info = seen[0] as { modelId: string; decisionBasis: string; estCostUsd: number };
    expect(info.modelId).toBe("faux-b");
    expect(info.decisionBasis).toBe("memory");
    expect(info.estCostUsd).toBeCloseTo(0.001, 8);
    reg.unregister();
  });

  test("pinned turns hit the gate too — the case the beforeRoute seam could never cover", async () => {
    resetAll();
    registerModel(FAUX_A);
    registerModel(FAUX_B);
    const reg = registerFauxProvider([FAUX_A, FAUX_B]);
    reg.setResponses([new AssistantMessage({ content: [text("never sent")] })]);

    const svc = capturingService();
    const agent = buildAgent(svc, { pinned: true, candidates: ["faux-b"] });
    const seen: unknown[] = [];
    agent.confirmRun = async (info) => {
      seen.push(info);
      return false;
    };
    await expect(agent.promptRouted("hi")).rejects.toThrow(/cancel/);

    expect(reg.state.pendingResponseCount).toBe(1);
    expect((seen[0] as { decisionBasis: string } | undefined)?.decisionBasis).toBe("pinned");
    reg.unregister();
  });

  test("offline-fallback turns hit the gate with the offline reason attached", async () => {
    resetAll();
    registerModel(FAUX_A);
    registerModel(FAUX_B);
    const reg = registerFauxProvider([FAUX_A, FAUX_B]);
    reg.setResponses([new AssistantMessage({ content: [text("never sent")] })]);

    const svc = capturingService({ status: 500, body: { detail: "minima is down" } });
    const agent = buildAgent(svc, { allowOffline: true });
    const seen: unknown[] = [];
    agent.confirmRun = async (info) => {
      seen.push(info);
      return false;
    };
    await expect(agent.promptRouted("hi")).rejects.toThrow(/cancel/);

    expect(reg.state.pendingResponseCount).toBe(1);
    const info = seen[0] as { decisionBasis: string; offlineReason: string | null } | undefined;
    expect(info?.decisionBasis).toBe("offline");
    expect(info?.offlineReason ?? "").toContain("down");
    reg.unregister();
  });

  test("the gate fires once per prompt — recovery-ladder rungs don't re-ask", async () => {
    resetAll();
    registerModel(FAUX_A);
    registerModel(FAUX_B);
    const reg = registerFauxProvider([FAUX_A, FAUX_B]);
    reg.setResponses([
      new AssistantMessage({ content: [text("weak answer")] }),
      new AssistantMessage({ content: [text("second rung")] }),
    ]);

    const svc = capturingService();
    // Judge grade 0.1 < threshold_used 0.5 on every turn => the ladder escalates to rung 2.
    const agent = buildAgent(
      svc,
      { judgeSampleRate: 1 },
      { judge: new ConstJudge(0.1), recoveryRungs: 1 },
    );
    let asks = 0;
    agent.confirmRun = async () => {
      asks += 1;
      return true;
    };
    await agent.promptRouted("hi");

    expect(reg.state.pendingResponseCount).toBe(0); // both rungs ran
    expect(asks).toBe(1); // confirmed once, at the turn boundary
    reg.unregister();
  });
});
