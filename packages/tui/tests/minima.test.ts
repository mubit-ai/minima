import { describe, expect, test } from "bun:test";
import type { AgentTool } from "../src/agent/tools.ts";
import {
  AssistantMessage,
  type Model,
  Usage,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";
import {
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  type RoutingResult,
  harnessConfig,
} from "../src/minima/index.ts";

function echoTool(): AgentTool {
  return {
    name: "echo",
    description: "echo the message back",
    parameters: {
      jsonSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      validate(v) {
        if (v && typeof v === "object" && "msg" in v) {
          return { ok: true, value: v as Record<string, unknown> };
        }
        return { ok: false, errors: ["msg is required"] };
      },
    },
    async execute(args) {
      return { content: [text(String((args as { msg: string }).msg))], is_error: false };
    },
  };
}

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

/** A mock Minima service: returns a recommend response for the faux model, captures calls. */
function mockService() {
  const feedbackCalls: Record<string, unknown>[] = [];
  const recommendCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.pathname === "/v1/recommend") {
      recommendCalls.push(init?.body ? JSON.parse(init.body) : {});
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
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return { status: 200, json: async () => ({ accepted: true, record_id: "o1" }) };
    }
    return { status: 404, json: async () => ({ detail: "not found" }) };
  };
  return { fetchLike, feedbackCalls, recommendCalls };
}

describe("MinimaAgent full loop (route -> run -> judge -> feedback)", () => {
  test("routes via Minima, runs the loop, judges, and sends feedback", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("42")], stop_reason: "stop" })]);

    const { fetchLike, feedbackCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
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
    // NEVER claimed unless tests actually verified the outcome — a fabricated true makes
    // the server treat this as high-importance ground truth (poisons the learning loop).
    expect(fb.verified_in_production).toBe(false);
    // Judged turn (quality present) → no unjudged tag.
    expect(fb.notes).toBeUndefined();

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
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
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
    // Unjudged turns are tagged, never claimed verified — the server substitutes a
    // fabricated quality (0.9) for null-quality successes and treats verified ones as
    // high-importance ground truth, so an untagged/false-verified turn poisons learning.
    expect(fb.verified_in_production).toBe(false);
    expect(fb.notes).toBe("judged=false");
    reg.unregister();
  });

  test("feedback reports the RUN-TOTAL cost across turns, not the last turn only", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    const turn1 = new AssistantMessage({
      content: [toolCall("c1", "echo", { msg: "ping" })],
      stop_reason: "toolUse",
    });
    turn1.usage = new Usage({ input: 1000, output: 200 });
    turn1.usage.cost.total = 0.03;
    const turn2 = new AssistantMessage({ content: [text("done")] });
    turn2.usage = new Usage({ input: 1400, output: 100 });
    turn2.usage.cost.total = 0.02;
    reg.setResponses([turn1, turn2]);

    const { fetchLike, feedbackCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const meter = new CostMeter();

    const agent = new MinimaAgent({
      config,
      router,
      judge: new ConstJudge(0.9),
      meter,
      tools: [echoTool()],
    });
    await agent.promptRouted("use echo then answer");

    // Provider prices at FAUX_MODEL cost {input:1, output:2} $/Mtok:
    //   turn1 = 1000*1e-6 + 200*2e-6 = 0.0014 ; turn2 = 1400*1e-6 + 100*2e-6 = 0.0016
    const fb = feedbackCalls[0] as Record<string, unknown>;
    expect(fb.actual_cost_usd).toBeCloseTo(0.003, 8); // BOTH turns — not the last one (0.0016)
    expect(fb.input_tokens).toBe(2400);
    expect(fb.output_tokens).toBe(300);
    // The meter records the same run total (est→actual comparisons stay truthful).
    expect(meter.totals().actualCostUsd).toBeCloseTo(0.003, 8);
    reg.unregister();
  });

  test("recommend carries the routing levers (constraints, difficulty, context size)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    const { fetchLike, recommendCalls } = mockService();
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });

    const agent = new MinimaAgent({ config, router, judge: { grade: async () => null } });
    const routing = await agent.promptRouted("fix the flaky test", {
      difficulty: "hard",
      maxCostPerCall: 0.25,
      minQuality: 0.8,
      excludedModels: ["dead-model"],
    });

    const req = recommendCalls[0] as Record<string, any>;
    expect(req.task.difficulty).toBe("hard");
    expect(req.task.expected_input_tokens).toBeGreaterThan(0); // live-context estimate
    expect(req.constraints.max_cost_per_call).toBe(0.25);
    expect(req.constraints.min_quality).toBe(0.8);
    expect(req.constraints.excluded_models).toEqual(["dead-model"]);
    expect(req.constraints.candidate_models).toEqual(["test-faux"]);
    // The previously-dropped response fields round-trip into RoutingResult.
    expect(routing?.classifiedTaskType).toBe("code");
    expect(routing?.classifiedDifficulty).toBe("easy");
    expect(routing?.selectionPolicy).toBe("argmin");
    expect(routing?.recommendedActions).toEqual([]);
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
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: true,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });

    const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9) });

    const routing = await agent.promptRouted("hi");
    expect(routing).toBeNull(); // offline — no routing result
    expect(agent.offlineReason).toMatch(/down|500/);
    // The run still produced an assistant on the fallback model.
    expect(agent.agentState.messages.some((m) => m.role === "assistant")).toBe(true);
    reg.unregister();
  });

  test("an accepted=false feedback response surfaces in lastFeedbackError (not silent)", async () => {
    resetAll();
    registerModel(FAUX_MODEL);
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);

    // Service accepts recommend but rejects feedback with memory_write_failed.
    const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
        return {
          status: 200,
          json: async () => ({
            recommendation_id: "rec-rej",
            recommended_model: {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 1,
            },
            ranked: [],
            confidence: 0.8,
            decision_basis: "memory",
            threshold_used: 0.5,
            classified_task_type: "code",
            classified_difficulty: "easy",
            catalog_version: "v1",
          }),
        };
      }
      if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
        return {
          status: 200,
          json: async () => ({ accepted: false, warnings: ["memory_write_failed"] }),
        };
      }
      return { status: 404, json: async () => ({ detail: "nope" }) };
    };
    const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike });
    const config = harnessConfig({
      candidates: ["test-faux"],
      allowOffline: false,
      minimaApiKey: "k",
    });
    const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
    const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9) });

    await agent.promptRouted("do it");
    expect(agent.lastFeedbackError).toContain("memory_write_failed");
    reg.unregister();
  });
});
