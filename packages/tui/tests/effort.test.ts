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
import { EFFORT_BY_DIFFICULTY } from "../src/minima/runtime.ts";

const FAUX_MODEL: Model = {
  id: "test-faux",
  provider: "faux",
  api: "faux",
  name: "Test Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function service(difficulty: string) {
  const fetchLike = async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/recommend") {
      return {
        status: 200,
        json: async () => ({
          recommendation_id: "rec-1",
          recommended_model: {
            model_id: "test-faux",
            provider: "faux",
            predicted_success: 0.9,
            est_cost_usd: 0.001,
            score: 1,
          },
          ranked: [
            {
              model_id: "test-faux",
              provider: "faux",
              predicted_success: 0.9,
              est_cost_usd: 0.001,
              score: 1,
            },
          ],
          confidence: 0.8,
          decision_basis: "memory",
          threshold_used: 0.5,
          classified_task_type: "code",
          classified_difficulty: difficulty,
          catalog_version: "v1",
        }),
      };
    }
    if ((init?.method ?? "GET") === "POST" && u.pathname === "/v1/feedback") {
      return {
        status: 200,
        json: async () => ({
          accepted: true,
          reinforced_entry_ids: ["mem-1", "mem-2"],
          lesson_promoted: true,
        }),
      };
    }
    return { status: 404, json: async () => ({ detail: "nope" }) };
  };
  return fetchLike;
}

function makeAgent(difficulty: string, db?: MinimaDb) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(FAUX_MODEL);
  const reg = registerFauxProvider([FAUX_MODEL]);
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: service(difficulty) });
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
  if (db) {
    agent.db = db;
    agent.runId = db.startRun({ projectKey: "p" });
  }
  return { agent, reg };
}

describe("effort routing Phase A (staged, default off)", () => {
  test("difficulty→thinking map covers the wire enum", () => {
    expect(EFFORT_BY_DIFFICULTY.trivial).toBe("off");
    expect(EFFORT_BY_DIFFICULTY.expert).toBe("high");
  });

  test("OFF by default: classified difficulty never touches thinkingLevel", async () => {
    const { agent, reg } = makeAgent("expert");
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);
    let seen: string | null = null;
    agent.subscribe((ev) => {
      if (ev.type === "turn_start") seen = agent.agentState.thinkingLevel;
    });
    await agent.promptRouted("hard thing");
    expect(seen).toBe("off");
    expect(agent.agentState.thinkingLevel).toBe("off");
    reg.unregister();
  });

  test("ON: expert difficulty raises effort for THIS prompt, restored after", async () => {
    const { agent, reg } = makeAgent("expert");
    agent.autoEffort = true;
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);
    let seen: string | null = null;
    agent.subscribe((ev) => {
      if (ev.type === "turn_start") seen = agent.agentState.thinkingLevel;
    });
    await agent.promptRouted("hard thing");
    expect(seen).toBe("high"); // effort applied during the run
    expect(agent.agentState.thinkingLevel).toBe("off"); // restored — no leak to next prompt
    reg.unregister();
  });
});

describe("feedback provenance persistence (M-I)", () => {
  test("FeedbackResponse ids land on the decision row instead of being discarded", async () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const { agent, reg } = makeAgent("easy", db);
    reg.setResponses([new AssistantMessage({ content: [text("ok")] })]);
    await agent.promptRouted("do it");
    const rows = db.getRunDecisions(agent.runId!);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.reinforced_entry_ids))).toEqual(["mem-1", "mem-2"]);
    expect(rows[0]!.lesson_promoted).toBe(1);
    reg.unregister();
    db.close();
  });
});
