import { describe, expect, test } from "bun:test";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
  type RoutingResult,
} from "../src/minima/index.ts";
import {
  AssistantMessage,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  type Model,
} from "../src/ai/index.ts";

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

/** A mock Minima service: returns a recommend response for the faux model, captures feedback. */
function mockService() {
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-xyz",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
            rationale: "cheapest viable",
          },
          ranked: [
            { model_id: "test-faux", provider: "faux", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 },
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
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, feedbackCalls };
}

describe("MinimaAgent full loop (route -> run -> judge -> feedback)", () => {
  test("routes via Minima, runs the loop, judges, and sends feedback", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("42")], stop_reason: "stop" })]);

    const { fetchLike, feedbackCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({ candidates: ["test-faux"], allowOffline: false, minimaApiKey: "k" });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const meter = new CostMeter();

    const agent = new MinimaAgent({
      config,
      router,
      judge: new ConstJudge(0.9),
      meter,
      tools: [],
    });

    const routing = (await agent.promptRouted("what is 6*7?")) as RoutingResult;

    // Routed to the faux model via Minima.
    expect(routing?.chosenModelId).toBe("test-faux");
    expect(routing?.recommendationId).toBe("rec-xyz");
    expect(agent.agentState.model.id).toBe("test-faux");

    // The agent loop ran and produced an assistant message.
    expect(agent.agentState.messages.some((m) => m.role === "assistant")).toBe(true);

    // Feedback was sent with quality 0.9 -> outcome "success", plus realized usage + latency.
    expect(feedbackCalls).toHaveLength(1);
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.recommendation_id).toBe("rec-xyz");
    expect(fb.chosen_model_id).toBe("test-faux");
    expect(fb.outcome).toBe("success");
    expect(fb.quality_score).toBe(0.9);
    expect(fb.latency_ms).toBeGreaterThanOrEqual(0);
    expect(fb.verified_in_production).toBe(true);

    // The meter recorded a successful row.
    const totals = meter.totals();
    expect(totals.n).toBe(1);
    expect(totals.successes).toBe(1);
    reg.unregister();
  });

  test("judge abstention sends feedback with no fabricated quality", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const { fetchLike, feedbackCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({ candidates: ["test-faux"], allowOffline: false, minimaApiKey: "k" });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });

    const agent = new MinimaAgent({
      config,
      router,
      judge: { grade: async () => null }, // abstains
    });

    await agent.promptRouted("do something");
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.outcome).toBe("success");
    expect(fb.quality_score).toBeUndefined();
    reg.unregister();
  });

  test("offline fallback runs on the current model with no feedback when Minima is unreachable", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("offline reply")] })]);

    // A client whose recommend always fails.
    const failingFetch = async () => ({ status: 500, json: async () => ({ detail: "down" }) });
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: failingFetch });
    const config = harnessConfig({ candidates: ["test-faux"], allowOffline: true, minimaApiKey: "k" });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });

    const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9) });

    const routing = await agent.promptRouted("hi");
    expect(routing).toBeNull(); // offline — no routing result
    expect(agent.offlineReason).toMatch(/down|500/);
    // The run still produced an assistant on the fallback model.
    expect(agent.agentState.messages.some((m) => m.role === "assistant")).toBe(true);
    reg.unregister();
  });
});
