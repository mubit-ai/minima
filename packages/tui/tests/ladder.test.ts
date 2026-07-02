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

/** Mock service: recommends cheap-model unless it's excluded, then big-model. */
function ladderService() {
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
            est_cost_usd: pick === "cheap-model" ? 0.001 : 0.01,
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
          fallback_model: {
            model_id: "big-model",
            provider: "faux",
            predicted_success: 0.95,
            est_cost_usd: 0.01,
            score: 2,
          },
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
      return { status: 200, json: async () => ({ accepted: true }) };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return { fetchLike, recommendCalls, feedbackCalls };
}

function setup(judge: ConstJudge, db?: MinimaDb) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([CHEAP, BIG]);
  const svc = ladderService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    candidates: ["cheap-model", "big-model"],
    allowOffline: false,
    minimaApiKey: "k",
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge, meter: new CostMeter(), tools: [] });
  if (db) {
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });
  }
  return { agent, reg, svc };
}

describe("recovery ladder", () => {
  test("gate: a provider hard failure recovers on the next rung exactly once", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg, svc } = setup(new ConstJudge(0.9), db);
    reg.setResponses([
      new AssistantMessage({
        content: [text("")],
        stop_reason: "error",
        error_message: "upstream 500",
      }),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    // The retry excluded the failed model → the server picked the bigger one.
    expect(routing?.chosenModelId).toBe("big-model");
    expect(svc.recommendCalls).toHaveLength(2);
    expect((svc.recommendCalls[1] as any).constraints.excluded_models).toEqual(["cheap-model"]);
    expect(agent.ladderEscalations).toBe(1);

    // Both rungs sent feedback: the failure AND the recovery.
    expect(svc.feedbackCalls).toHaveLength(2);
    expect((svc.feedbackCalls[0] as any).outcome).toBe("failure");
    expect((svc.feedbackCalls[1] as any).outcome).toBe("success");

    // Both rungs persisted; the retry links to the first rung's rec_id.
    const rows = db.getRunDecisions(agent.runId!);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.parent_rec_id).toBe(String(rows[0]!.rec_id));

    // The failed rung's messages were rolled back — one user turn, one final answer.
    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("recovered answer");
    reg.unregister();
    db.close();
  });

  test("gate: a judged grade below τ escalates; a PASSING grade does not", async () => {
    // τ = 0.7 from the mock service. ConstJudge(0.3) fails it; ConstJudge(0.9) passes.
    {
      const { agent, reg, svc } = setup(new ConstJudge(0.3));
      reg.setResponses([
        new AssistantMessage({ content: [text("bad answer")] }),
        new AssistantMessage({ content: [text("better answer")] }),
        new AssistantMessage({ content: [text("third answer")] }),
      ]);
      await agent.promptRouted("hard question");
      // Judge fails EVERY rung (const 0.3), so it walks all rungs: 1 + 2 retries.
      expect(svc.recommendCalls.length).toBe(3);
      expect(agent.ladderEscalations).toBe(2);
      reg.unregister();
    }
    {
      const { agent, reg, svc } = setup(new ConstJudge(0.9));
      reg.setResponses([new AssistantMessage({ content: [text("good answer")] })]);
      await agent.promptRouted("easy question");
      expect(svc.recommendCalls).toHaveLength(1); // no escalation
      expect(agent.ladderEscalations).toBe(0);
      reg.unregister();
    }
  });

  test("gate: NEVER retries on a null judge (abstain is not a failure)", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(null));
    reg.setResponses([new AssistantMessage({ content: [text("unjudged answer")] })]);
    await agent.promptRouted("whatever");
    expect(svc.recommendCalls).toHaveLength(1);
    expect(agent.ladderEscalations).toBe(0);
    reg.unregister();
  });

  test("recoveryRungs=0 disables the ladder entirely", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9));
    agent.recoveryRungs = 0;
    reg.setResponses([
      new AssistantMessage({ content: [text("")], stop_reason: "error", error_message: "boom" }),
    ]);
    await agent.promptRouted("x"); // provider error surfaces as failure feedback, no retry
    expect(svc.recommendCalls).toHaveLength(1);
    expect(agent.ladderEscalations).toBe(0);
    expect((svc.feedbackCalls[0] as Record<string, unknown>).outcome).toBe("failure");
    reg.unregister();
  });
});
