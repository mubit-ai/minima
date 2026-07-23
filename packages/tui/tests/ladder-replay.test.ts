import { describe, expect, test } from "bun:test";
import type { AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
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
    async execute(_id, params) {
      return { content: [text(`echo: ${params.msg}`)] };
    },
  };
}

function echoTurn(id: string): AssistantMessage {
  return new AssistantMessage({
    content: [toolCall(id, "echo", { msg: "ping" })],
    stop_reason: "toolUse",
  });
}

function hardFail(message: string): AssistantMessage {
  return new AssistantMessage({
    content: [text("")],
    stop_reason: "error",
    error_message: message,
  });
}

function setup(judge: ConstJudge, opts: { tools?: AgentTool[]; steer?: boolean } = {}) {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
  registerModel(CHEAP);
  registerModel(BIG);
  const reg = registerFauxProvider([CHEAP, BIG]);
  const svc = ladderService();
  const client = new MinimaClient({ baseUrl: "http://svc.local", fetch: svc.fetchLike });
  const config = harnessConfig({
    judgeSampleRate: 1,
    candidates: ["cheap-model", "big-model"],
    allowOffline: false,
    minimaApiKey: "k",
    bigPlan: false,
    stopStrikes: 0,
    ...(opts.steer === undefined ? {} : { steer: opts.steer }),
  });
  const router = new MinimaRouter({ client, config, mapping: new ModelMapping() });
  const agent = new MinimaAgent({
    config,
    router,
    judge,
    meter: new CostMeter(),
    tools: opts.tools ?? [],
  });
  return { agent, reg, svc };
}

describe("recovery ladder — replay guard", () => {
  test("an effectful failed rung escalates WITHOUT erasing context — the toolResult survives", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9), { tools: [echoTool()] });
    reg.setResponses([
      echoTurn("t1"),
      hardFail("boom"),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    const routing = await agent.promptRouted("do the thing");

    expect(routing?.chosenModelId).toBe("big-model");
    expect(svc.recommendCalls).toHaveLength(2);
    expect(agent.ladderEscalations).toBe(1);

    const toolResults = agent.agentState.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.textContent).toBe("echo: ping");

    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants[2]!.textContent).toBe("recovered answer");
    reg.unregister();
  });

  test("a clean hard-fail rung still rolls back", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9));
    reg.setResponses([
      hardFail("upstream 500"),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    await agent.promptRouted("do the thing");

    expect(svc.recommendCalls).toHaveLength(2);
    expect(agent.agentState.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("recovered answer");
    reg.unregister();
  });

  test("a text_only judge-fail rung still rolls back (ladder UX unchanged)", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.3));
    reg.setResponses([
      new AssistantMessage({ content: [text("bad answer 1")] }),
      new AssistantMessage({ content: [text("bad answer 2")] }),
      new AssistantMessage({ content: [text("bad answer 3")] }),
    ]);

    await agent.promptRouted("hard question");

    expect(svc.recommendCalls).toHaveLength(3);
    expect(agent.agentState.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("bad answer 3");
    reg.unregister();
  });

  test("after a retained rung, a later clean rung rolls back to ITS OWN start — kept evidence survives", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9), { tools: [echoTool()] });
    reg.setResponses([
      echoTurn("t1"),
      hardFail("boom"),
      hardFail("boom again"),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    await agent.promptRouted("do the thing");

    expect(svc.recommendCalls).toHaveLength(3);

    const toolResults = agent.agentState.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.textContent).toBe("echo: ping");

    const errorAssistants = agent.agentState.messages.filter(
      (m) => m.role === "assistant" && (m as AssistantMessage).stop_reason === "error",
    );
    expect(errorAssistants).toHaveLength(1);
    expect((errorAssistants[0] as AssistantMessage).error_message).toBe("boom");

    const reprompts = agent.agentState.messages.filter(
      (m) => m.role === "user" && m.ladder_reprompt === true,
    );
    expect(reprompts).toHaveLength(1);

    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants[assistants.length - 1]!.textContent).toBe("recovered answer");
    reg.unregister();
  });

  test("steer=false keeps today's rollback even for an effectful rung", async () => {
    const { agent, reg, svc } = setup(new ConstJudge(0.9), {
      tools: [echoTool()],
      steer: false,
    });
    reg.setResponses([
      echoTurn("t1"),
      hardFail("boom"),
      new AssistantMessage({ content: [text("recovered answer")] }),
    ]);

    await agent.promptRouted("do the thing");

    expect(svc.recommendCalls).toHaveLength(2);
    expect(agent.agentState.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.textContent).toBe("recovered answer");
    reg.unregister();
  });
});
