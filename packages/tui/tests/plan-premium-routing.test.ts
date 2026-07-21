import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
} from "../src/minima/index.ts";

const FAUX: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};
const CLAUDE: Model = { ...FAUX, id: "claude-x", provider: "anthropic", api: "anthropic-messages" };
const GPT: Model = { ...FAUX, id: "gpt-x", provider: "openai", api: "openai-completions" };
const CHEAP: Model = { ...FAUX, id: "cheap-model" };
const BIG: Model = { ...FAUX, id: "big-model" };

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.a;
  if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.o;
});

/** Mock service capturing candidate_models + excluded_models; picks cheap-model unless
 *  excluded (then big-model), falling back to test-faux when neither is a candidate. */
function service(thresholdUsed = 0.5) {
  const recommendCalls: Record<string, unknown>[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      const req = init?.body ? JSON.parse(init.body) : {};
      recommendCalls.push(req);
      const candidates: string[] = req.constraints?.candidate_models ?? [];
      const excluded: string[] = req.constraints?.excluded_models ?? [];
      const pick = candidates.includes("cheap-model")
        ? excluded.includes("cheap-model")
          ? "big-model"
          : "cheap-model"
        : "test-faux";
      const card = {
        model_id: pick,
        provider: "faux",
        predicted_success: 0.9,
        est_cost_usd: 0.001,
        score: 0.001,
      };
      return {
        status: 200,
        json: async () => ({
          recommendation_id: `rec-${recommendCalls.length}`,
          recommended_model: card,
          ranked: [card],
          confidence: 0.8,
          decision_basis: "prior",
          threshold_used: thresholdUsed,
          catalog_version: "v1",
        }),
      };
    }
    if (u.pathname === "/v1/feedback")
      return { status: 200, json: async () => ({ accepted: true }) };
    return { status: 404, json: async () => ({}) };
  };
  return { fetchLike, recommendCalls };
}

function buildAgent(
  fetchLike: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
  over: Parameters<typeof harnessConfig>[0] = {},
  judge = new ConstJudge(0.9),
) {
  registerModel(CLAUDE);
  registerModel(GPT);
  registerModel(FAUX);
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([FAUX, CHEAP, BIG]);
  reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);
  const config = harnessConfig({
    candidates: ["test-faux"],
    allowOffline: false,
    minimaApiKey: "k",
    ...over,
  });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge, tools: [] });
  return { agent, reg, config };
}

describe("promptRouted candidates — the plan-premium hard pool", () => {
  test("explicit candidates ride as constraints.candidate_models, filtered to runnable", async () => {
    process.env.ANTHROPIC_API_KEY = "k"; // openai absent → gpt-x filtered from the pool
    const { fetchLike, recommendCalls } = service();
    const { agent, reg } = buildAgent(fetchLike);
    await agent.promptRouted("hi", { candidates: ["claude-x", "gpt-x"] });
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["claude-x"],
    });
    reg.unregister();
  });

  test("zero runnable → the explicit pool is sent unchanged, never widened to config", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg } = buildAgent(fetchLike);
    await agent.promptRouted("hi", { candidates: ["claude-x", "gpt-x"] });
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["claude-x", "gpt-x"],
    });
    reg.unregister();
  });

  test("recovery rungs keep the premium pool with the failed model in excluded_models", async () => {
    const { fetchLike, recommendCalls } = service(0.7);
    // ConstJudge(0.1) < threshold_used 0.7 → the rung fails → the ladder re-routes once.
    const { agent, reg } = buildAgent(
      fetchLike,
      { judgeSampleRate: 1, stopStrikes: 0 },
      new ConstJudge(0.1),
    );
    agent.recoveryRungs = 1;
    reg.setResponses([
      new AssistantMessage({ content: [text("try 1")], stop_reason: "stop" }),
      new AssistantMessage({ content: [text("try 2")], stop_reason: "stop" }),
    ]);
    await agent.promptRouted("hi", { candidates: ["cheap-model", "big-model"] });
    expect(recommendCalls).toHaveLength(2);
    expect(recommendCalls[0]?.constraints).toMatchObject({
      candidate_models: ["cheap-model", "big-model"],
    });
    const second = recommendCalls[1]?.constraints as {
      candidate_models?: string[];
      excluded_models?: string[];
    };
    expect(second.candidate_models).toEqual(["cheap-model", "big-model"]);
    expect(second.excluded_models).toContain("cheap-model");
    reg.unregister();
  });

  test("a hard /model pin wins: zero recommend calls, runs the pinned model", async () => {
    const { fetchLike, recommendCalls } = service();
    const { agent, reg } = buildAgent(fetchLike, { pinned: true, candidates: ["test-faux"] });
    await agent.promptRouted("hi", { candidates: ["claude-x"] });
    expect(recommendCalls).toHaveLength(0);
    expect(agent.agentState.model?.id).toBe("test-faux");
    reg.unregister();
  });

  test("offline with explicit candidates lands on the first resolvable candidate", async () => {
    const fetchLike = async () => {
      throw new Error("routing down");
    };
    const { agent, reg } = buildAgent(fetchLike as never, {
      allowOffline: true,
      candidates: ["cheap-model"],
    });
    agent.agentState.model = reg.getModel("cheap-model");
    const routing = await agent.promptRouted("hi", { candidates: ["test-faux"] });
    expect(routing).toBeNull();
    expect(agent.agentState.model?.id).toBe("test-faux");
    reg.unregister();
  });
});
