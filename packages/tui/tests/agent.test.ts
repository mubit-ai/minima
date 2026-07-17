import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  textDelta,
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

/** A minimal echo tool used to exercise the tool-execution loop. */
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

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
    return undefined;
  });
  return events;
}

describe("Agent + agentLoop", () => {
  test("text reply emits the full event sequence in one turn", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([new AssistantMessage({ content: [text("hello there")] })]);

    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    const events = collect(agent);
    await agent.prompt("hi");

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "agent_start",
      "message_start",
      "message_end",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    // The assistant message landed in state.
    expect(agent.agentState.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(agent.agentState.turnsTaken).toBe(1);
    reg.unregister();
  });

  test("tool-use runs two turns: tool execution then a final answer", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("c1", "echo", { msg: "ping" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("all done")] }),
    ]);

    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    const events = collect(agent);
    await agent.prompt("use echo");

    const types = events.map((e) => e.type);
    // tool execution events appear, plus a toolResult message_start/end pair.
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end",
    )!;
    expect(toolEnd.isError).toBe(false);
    expect(toolEnd.result?.content[0]).toMatchObject({ type: "text", text: "echo: ping" });

    // toolResult message was appended.
    const toolResults = agent.agentState.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_name).toBe("echo");

    // Two assistant turns.
    expect(agent.agentState.turnsTaken).toBe(2);
    reg.unregister();
  });

  test("unknown tool produces a tool-error result fed back to the model", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("c1", "nope", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("recovered")] }),
    ]);

    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()] });
    const events = collect(agent);
    await agent.prompt("call missing tool");

    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end",
    )!;
    expect(toolEnd.isError).toBe(true);
    expect((toolEnd.result?.content[0] as { text: string }).text).toMatch(/Unknown tool/);
    reg.unregister();
  });

  test("beforeToolCall can block a tool call", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("c1", "echo", { msg: "x" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("ok")] }),
    ]);

    const agent = new Agent({
      model: reg.getModel(),
      tools: [echoTool()],
      beforeToolCall: async () => ({ block: true, reason: "not allowed" }),
    });
    const events = collect(agent);
    await agent.prompt("try echo");

    const toolEnd = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end",
    )!;
    expect(toolEnd.isError).toBe(true);
    expect(toolEnd.result?.content[0]).toMatchObject({ type: "text", text: "not allowed" });
    reg.unregister();
  });

  test("maxTurns caps the loop", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    // Always requests a tool; never resolves.
    reg.appendResponses([
      new AssistantMessage({
        content: [toolCall("c1", "echo", { msg: "x" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("c2", "echo", { msg: "x" })],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({
        content: [toolCall("c3", "echo", { msg: "x" })],
        stop_reason: "toolUse",
      }),
    ]);

    const agent = new Agent({ model: reg.getModel(), tools: [echoTool()], maxTurns: 2 });
    await agent.prompt("loop");
    expect(agent.agentState.turnsTaken).toBe(2);
    reg.unregister();
  });

  test("abort() during a turn stops the loop before the next turn", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("c1", "abort", {})],
        stop_reason: "toolUse",
      }),
      // This second response must NEVER be consumed once we abort in turn 1.
      new AssistantMessage({ content: [text("should not run")] }),
    ]);

    let agent: Agent;
    const abortTool: AgentTool = {
      name: "abort",
      description: "aborts the run",
      parameters: {
        jsonSchema: { type: "object", properties: {} },
        validate: (v) => ({ ok: true, value: (v as Record<string, unknown>) ?? {} }),
      },
      async execute() {
        agent.abort();
        return { content: [text("aborting")] };
      },
    };

    agent = new Agent({ model: reg.getModel(), tools: [abortTool] });
    await agent.prompt("go");

    // Only the first turn ran; the second queued response was never streamed.
    expect(agent.agentState.turnsTaken).toBe(1);
    expect(agent.agentState.messages.some((m) => m.textContent === "should not run")).toBe(false);
    reg.unregister();
  });

  test("abort() mid-stream stops instantly, without waiting for the next chunk", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);

    // A stream that yields one delta then hangs forever on the next chunk —
    // simulates a slow/mid-token generation. If abort weren't raced against the
    // pending chunk, the loop would block here indefinitely.
    let returned = false;
    const hangingStreamFn = () => {
      let calls = 0;
      const iter = {
        async next(): Promise<IteratorResult<unknown>> {
          calls += 1;
          if (calls === 1) return { done: false, value: textDelta("hi", 0) };
          await new Promise<never>(() => {}); // hang until the iterator is torn down
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<unknown>> {
          returned = true;
          return { done: true, value: undefined };
        },
      };
      return {
        result: async () => new AssistantMessage({ content: [text("unused")] }),
        [Symbol.asyncIterator]: () => iter,
      };
    };

    let agent: Agent;
    agent = new Agent({ model: reg.getModel(), streamFn: hangingStreamFn });
    // Abort the moment the first streamed delta lands.
    agent.subscribe((e) => {
      if (e.type === "message_update") agent.abort();
      return undefined;
    });

    // Resolves promptly (not hanging on the stalled chunk) → proof of instant abort.
    await agent.prompt("go");

    expect(agent.agentState.errorMessage).toBe("aborted");
    expect(returned).toBe(true); // provider iterator was torn down (HTTP request killed)
    expect(agent.agentState.turnsTaken).toBe(1);
    reg.unregister();
  });

  test("a prompt after an abort is a fresh turn — the model doesn't answer both", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);

    let mode: "hang" | "reply" = "hang";
    const streamFn = () => {
      if (mode === "reply") {
        const events = [textDelta("answer-2", 0)];
        let i = 0;
        const msg = new AssistantMessage({
          content: [text("answer-2")],
          stop_reason: "stop",
          model: FAUX_MODEL.id,
        });
        return {
          result: async () => msg,
          [Symbol.asyncIterator]: () => ({
            async next(): Promise<IteratorResult<unknown>> {
              if (i < events.length) return { done: false, value: events[i++] };
              return { done: true, value: undefined };
            },
          }),
        };
      }
      // hang mode: yield one delta, then stall until aborted
      let calls = 0;
      return {
        result: async () => new AssistantMessage({ content: [text("unused")] }),
        [Symbol.asyncIterator]: () => ({
          async next(): Promise<IteratorResult<unknown>> {
            calls += 1;
            if (calls === 1) return { done: false, value: textDelta("partial-1", 0) };
            await new Promise<never>(() => {});
            return { done: true, value: undefined };
          },
          async return(): Promise<IteratorResult<unknown>> {
            return { done: true, value: undefined };
          },
        }),
      };
    };

    let agent: Agent;
    agent = new Agent({ model: reg.getModel(), streamFn });
    agent.subscribe((e) => {
      if (mode === "hang" && e.type === "message_update") agent.abort();
      return undefined;
    });

    await agent.prompt("first question"); // aborted mid-stream
    mode = "reply";
    await agent.prompt("second question"); // must be answered on its own

    // History is strictly alternating — no two user messages in a row for the
    // provider to merge into one "answer both" prompt.
    const roles = agent.agentState.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);

    // The aborted turn was committed as its own assistant message, preserving the
    // partial text plus a marker.
    const abortedTurn = agent.agentState.messages[1] as AssistantMessage;
    expect(abortedTurn.stop_reason).toBe("aborted");
    expect(abortedTurn.textContent).toContain("partial-1");
    expect(abortedTurn.textContent).toContain("[aborted by user]");

    // The second prompt was answered on its own.
    expect((agent.agentState.messages[3] as AssistantMessage).textContent).toBe("answer-2");
    reg.unregister();
  });

  test("steering queue injects a user message between turns", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({ content: [text("first")] }),
      new AssistantMessage({ content: [text("steered")] }),
    ]);

    const agent = new Agent({ model: reg.getModel() });
    const events = collect(agent);
    // Steer before the first turn completes; it's drained after turn 1.
    agent.steer("please also do X");
    await agent.prompt("hi");

    // A steering user message was appended between turns.
    const userMsgs = agent.agentState.messages.filter((m) => m.role === "user");
    expect(userMsgs.map((m) => m.textContent)).toContain("please also do X");
    expect(agent.agentState.turnsTaken).toBe(2);
    reg.unregister();
  });
});
