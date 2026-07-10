import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  toolCall,
} from "../src/ai/index.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 0, output: 0 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
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
      return { content: [text(`echo: ${params.msg}`)], details: { base: true } };
    },
  };
}

function toolUseTurn(id: string): AssistantMessage {
  return new AssistantMessage({
    content: [toolCall(id, "echo", { msg: "ping" })],
    stop_reason: "toolUse",
  });
}

function findToolEnd(events: AgentEvent[]) {
  return events.find(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end",
  )!;
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    return undefined;
  });
  return events;
}

describe("Agent hook stacks", () => {
  test("before-hooks run in registration order; first block wins and later hooks never run", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([toolUseTurn("c1"), new AssistantMessage({ content: [text("ok")] })]);

    const calls: string[] = [];
    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    agent.addBeforeToolCall(async () => {
      calls.push("first");
      return null;
    });
    agent.addBeforeToolCall(async () => {
      calls.push("second");
      return { block: true, reason: "blocked by second" };
    });
    agent.addBeforeToolCall(async () => {
      calls.push("third");
      return null;
    });

    const events = collect(agent);
    await agent.prompt("go");

    expect(calls).toEqual(["first", "second"]);
    const toolEnd = findToolEnd(events);
    expect(toolEnd.isError).toBe(true);
    expect(toolEnd.result?.content[0]).toMatchObject({ type: "text", text: "blocked by second" });
    reg.unregister();
  });

  test("disposer removes only its own registration and is idempotent", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([toolUseTurn("c1"), new AssistantMessage({ content: [text("ok")] })]);

    const calls: string[] = [];
    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    const shared = async () => {
      calls.push("shared");
      return null;
    };
    const disposeA = agent.addBeforeToolCall(shared);
    agent.addBeforeToolCall(shared); // same fn registered twice
    agent.addBeforeToolCall(async () => {
      calls.push("keep");
      return null;
    });
    disposeA();
    disposeA(); // idempotent: must NOT remove the second `shared` registration

    await agent.prompt("go");

    expect(calls).toEqual(["shared", "keep"]);
    reg.unregister();
  });

  test("after-hooks fold: later hooks see earlier modifications; returns accumulate", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([toolUseTurn("c1"), new AssistantMessage({ content: [text("ok")] })]);

    const seenBySecond: string[] = [];
    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    agent.addAfterToolCall(async () => ({
      content: [text("replaced-by-first")],
      details: { a: 1 },
    }));
    agent.addAfterToolCall(async (ctx) => {
      seenBySecond.push((ctx.result.content[0] as { text: string }).text);
      expect(ctx.result.details).toMatchObject({ base: true, a: 1 });
      return { terminate: true, details: { b: 2 } };
    });

    const events = collect(agent);
    await agent.prompt("go");

    expect(seenBySecond).toEqual(["replaced-by-first"]);
    const toolEnd = findToolEnd(events);
    expect(toolEnd.isError).toBe(false);
    expect(toolEnd.result?.content[0]).toMatchObject({ type: "text", text: "replaced-by-first" });
    expect(toolEnd.result?.details).toMatchObject({ base: true, a: 1, b: 2 });
    expect(toolEnd.result?.terminate).toBe(true);
    reg.unregister();
  });

  test("constructor-seeded hooks fire first, before added hooks", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([toolUseTurn("c1"), new AssistantMessage({ content: [text("ok")] })]);

    const calls: string[] = [];
    const agent = new Agent({
      model: reg.getModel(),
      tools: [echoTool()],
      beforeToolCall: async () => {
        calls.push("seeded-before");
        return null;
      },
      afterToolCall: async () => {
        calls.push("seeded-after");
        return { details: { seeded: true } };
      },
    });
    agent.addBeforeToolCall(async () => {
      calls.push("added-before");
      return null;
    });
    agent.addAfterToolCall(async (ctx) => {
      calls.push("added-after");
      expect(ctx.result.details).toMatchObject({ seeded: true });
      return null;
    });

    const events = collect(agent);
    await agent.prompt("go");

    expect(calls).toEqual(["seeded-before", "added-before", "seeded-after", "added-after"]);
    const toolEnd = findToolEnd(events);
    expect(toolEnd.result?.details).toMatchObject({ base: true, seeded: true });
    reg.unregister();
  });

  test("blocked call never executes the tool and never runs after-hooks", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([toolUseTurn("c1"), new AssistantMessage({ content: [text("ok")] })]);

    let executed = false;
    let afterRan = false;
    const tool = echoTool();
    const inner = tool.execute;
    tool.execute = async (...args) => {
      executed = true;
      return inner(...args);
    };
    const agent = new Agent({ model: reg.getModel(), tools: [tool] });
    agent.addBeforeToolCall(async () => ({ block: true, reason: "no" }));
    agent.addAfterToolCall(async () => {
      afterRan = true;
      return null;
    });

    await agent.prompt("go");

    expect(executed).toBe(false);
    expect(afterRan).toBe(false);
    reg.unregister();
  });
});
