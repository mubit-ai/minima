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
  ConstJudge,
  CostMeter,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";
import { redoLastRouted } from "../src/minima/redo.ts";

const CHEAP: Model = {
  id: "cheap-model",
  provider: "faux",
  api: "faux",
  name: "Cheap",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const BIG: Model = {
  id: "big-model",
  provider: "faux",
  api: "faux",
  name: "Big",
  cost: { input: 10, output: 20 },
  context_window: 8192,
  max_tokens: 4096,
};

/** Mock service: recommends cheap-model unless excluded, then big-model. */
function redoService(opts: { feedbackResponse?: Record<string, unknown> } = {}) {
  const recommendCalls: Record<string, unknown>[] = [];
  const feedbackCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      const req = init?.body ? JSON.parse(init.body) : {};
      recommendCalls.push(req);
      const excluded: string[] = req.constraints?.excluded_models ?? [];
      const pick = excluded.includes("cheap-model") ? "big-model" : "cheap-model";
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: {
            model_id: pick,
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 0.001,
          },
          ranked: [
            {
              model_id: pick,
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 1,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.7,
          classified_task_type: "code",
          classified_difficulty: "easy",
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      feedbackCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        status: 200,
        json: async () => opts.feedbackResponse ?? { accepted: true },
      };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, recommendCalls, feedbackCalls };
}

function setup(opts: { svc?: ReturnType<typeof redoService>; pinned?: boolean } = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([CHEAP, BIG]);
  const svc = opts.svc ?? redoService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: opts.pinned ? ["cheap-model"] : ["cheap-model", "big-model"],
    pinned: opts.pinned ?? false,
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: false,
    stopStrikes: 0,
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge: new ConstJudge(0.9),
    meter: new CostMeter(),
    tools: [],
  });
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  agent.db = db;
  agent.runId = db.startRun({ projectKey: "p" });
  return { agent, reg, svc, db };
}

describe("/redo — corrective feedback + session exclusion", () => {
  test("corrective feedback wire: failure, evidence_source human, no quality/usage fields", async () => {
    const { agent, reg, svc, db } = setup();
    reg.setResponses([new AssistantMessage({ content: [text("first answer")] })]);
    await agent.promptRouted("write the parser");
    expect(svc.feedbackCalls).toHaveLength(1); // the routed turn's own feedback

    const result = await redoLastRouted(agent, "wrong tone entirely");
    expect(result.kind).toBe("reroute");
    expect(svc.feedbackCalls).toHaveLength(2);
    const fb = svc.feedbackCalls[1] as Record<string, unknown>;
    expect(fb.recommendation_id).toBe("rec-1");
    expect(fb.chosen_model_id).toBe("cheap-model");
    expect(fb.outcome).toBe("failure");
    expect(fb.evidence_source).toBe("human");
    expect(fb.quality_score).toBeUndefined();
    expect(fb.input_tokens).toBeUndefined();
    expect(fb.output_tokens).toBeUndefined();
    expect(fb.actual_cost_usd).toBeUndefined();
    expect(fb.latency_ms).toBeUndefined();
    expect(fb.verified_in_production).toBe(false);
    expect(fb.judged).toBe(false);
    expect(fb.notes).toBe("user_rejected: wrong tone entirely");
    reg.unregister();
    db.close();
  });

  test("the re-route carries excluded_models with the rejected model", async () => {
    const { agent, reg, svc, db } = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("first answer")] }),
      new AssistantMessage({ content: [text("second answer")] }),
    ]);
    await agent.promptRouted("write the parser");

    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("reroute");
    if (result.kind !== "reroute") throw new Error("unreachable");
    expect(result.task).toBe("write the parser");
    expect(result.excludedModelId).toBe("cheap-model");

    const routing = await agent.promptRouted(result.task);
    expect(routing?.chosenModelId).toBe("big-model");
    const rerouteReq = svc.recommendCalls[1] as { constraints?: { excluded_models?: string[] } };
    expect(rerouteReq.constraints?.excluded_models).toContain("cheap-model");
    reg.unregister();
    db.close();
  });

  test("the exclusion persists into the NEXT ordinary prompt's recommend request", async () => {
    const { agent, reg, svc, db } = setup();
    reg.setResponses([
      new AssistantMessage({ content: [text("a1")] }),
      new AssistantMessage({ content: [text("a2")] }),
      new AssistantMessage({ content: [text("a3")] }),
    ]);
    await agent.promptRouted("task one");
    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("reroute");
    if (result.kind !== "reroute") throw new Error("unreachable");
    await agent.promptRouted(result.task);

    await agent.promptRouted("a completely different task");
    const nextReq = svc.recommendCalls[2] as { constraints?: { excluded_models?: string[] } };
    expect(nextReq.constraints?.excluded_models).toContain("cheap-model");
    reg.unregister();
    db.close();
  });

  test("duplicate_feedback_ignored still re-routes, flagged alreadyLabeled", async () => {
    const svc = redoService({
      feedbackResponse: { accepted: true, warnings: ["duplicate_feedback_ignored"] },
    });
    const { agent, reg, db } = setup({ svc });
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("task");

    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("reroute");
    if (result.kind !== "reroute") throw new Error("unreachable");
    expect(result.alreadyLabeled).toBe(true);
    expect(result.message).toContain("already labeled");
    expect(agent.sessionExcludedModels).toContain("cheap-model");
    reg.unregister();
    db.close();
  });

  test("a feedback transport error never blocks the re-route (fail-open)", async () => {
    const base = redoService();
    let failFeedback = false;
    const svc = {
      ...base,
      fetchLike: async (url: string, init?: { method?: string; body?: string }) => {
        if (failFeedback && new URL(url).pathname === "/v1/feedback") {
          throw new Error("network down");
        }
        return base.fetchLike(url, init);
      },
    };
    const { agent, reg, db } = setup({ svc: svc as ReturnType<typeof redoService> });
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("task");

    failFeedback = true;
    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("reroute");
    expect(agent.sessionExcludedModels).toContain("cheap-model");
    reg.unregister();
    db.close();
  });

  test("/redo with no routed history is a no-op with a message", async () => {
    const { agent, reg, svc, db } = setup();
    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("no_history");
    expect(result.message).toContain("nothing routed");
    expect(svc.feedbackCalls).toHaveLength(0);
    expect(agent.sessionExcludedModels).toHaveLength(0);
    reg.unregister();
    db.close();
  });

  test("/redo after a pinned turn points at /model auto and sends nothing", async () => {
    const { agent, reg, svc, db } = setup({ pinned: true });
    reg.setResponses([new AssistantMessage({ content: [text("pinned answer")] })]);
    await agent.promptRouted("task");
    expect(svc.recommendCalls).toHaveLength(0); // pin bypasses routing entirely

    const result = await redoLastRouted(agent);
    expect(result.kind).toBe("pinned");
    expect(result.message).toContain("/model auto");
    expect(svc.feedbackCalls).toHaveLength(0);
    reg.unregister();
    db.close();
  });

  test("FIFO cap: adding beyond pool size - 1 drops the oldest exclusion", () => {
    const { agent, reg, db } = setup();
    agent.config.candidates = ["m1", "m2", "m3"]; // cap = 2
    agent.excludeModelForSession("m1");
    agent.excludeModelForSession("m2");
    agent.excludeModelForSession("m3");
    expect(agent.sessionExcludedModels).toEqual(["m2", "m3"]);
    reg.unregister();
    db.close();
  });

  test("the user note is truncated to the cap in feedback notes", async () => {
    const { agent, reg, svc, db } = setup();
    reg.setResponses([new AssistantMessage({ content: [text("answer")] })]);
    await agent.promptRouted("task");
    await redoLastRouted(agent, "x".repeat(500));
    const fb = svc.feedbackCalls[1] as Record<string, unknown>;
    expect(fb.notes).toBe(`user_rejected: ${"x".repeat(200)}`);
    reg.unregister();
    db.close();
  });
});
