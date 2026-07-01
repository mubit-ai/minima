import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ConstJudge,
  MinimaAgent,
  MinimaClient,
  MinimaRouter,
  ModelMapping,
  harnessConfig,
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

/** Mock service that captures each recommend request's candidate_models and always picks faux. */
function service() {
  const candidateLists: (string[] | undefined)[] = [];
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if (u.pathname === "/v1/recommend") {
      const body = init?.body ? JSON.parse(init.body) : {};
      candidateLists.push(body?.constraints?.candidate_models);
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: { model_id: "test-faux", provider: "faux", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 },
          ranked: [{ model_id: "test-faux", provider: "faux", predicted_success: 0.9, est_cost_usd: 0.001, score: 0.001 }],
          confidence: 0.8,
          decision_basis: "prior",
          threshold_used: 0.5,
          catalog_version: "v1",
        }),
      };
    }
    if (u.pathname === "/v1/feedback") return { status: 200, json: async () => ({ accepted: true }) };
    return { status: 404, json: async () => ({}) };
  };
  return { fetchLike, candidateLists };
}

function buildAgent(fetchLike: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>) {
  registerModel(CLAUDE);
  registerModel(GPT);
  registerModel(FAUX);
  const reg = registerFauxProvider([FAUX]);
  reg.setResponses([new AssistantMessage({ content: [text("ok")], stop_reason: "stop" })]);
  const config = harnessConfig({ candidates: ["claude-x", "gpt-x"], allowOffline: false, minimaApiKey: "k" });
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: fetchLike as never });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({ config, router, judge: new ConstJudge(0.9), tools: [] });
  return { agent, reg };
}

describe("route() candidate pre-filter by provider key", () => {
  test("only offers models whose provider key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "k"; // openai key absent → gpt-x must be filtered out
    const { fetchLike, candidateLists } = service();
    const { agent, reg } = buildAgent(fetchLike);
    await agent.promptRouted("hi");
    expect(candidateLists[0]).toEqual(["claude-x"]);
    reg.unregister();
  });

  test("falls back to the full candidate set when NO provider key is present", async () => {
    // neither key set → runnable is empty → send the full set, let the provider surface a
    // clear 'no API key' error rather than silently routing to nothing.
    const { fetchLike, candidateLists } = service();
    const { agent, reg } = buildAgent(fetchLike);
    await agent.promptRouted("hi");
    expect(candidateLists[0]).toEqual(["claude-x", "gpt-x"]);
    reg.unregister();
  });
});
