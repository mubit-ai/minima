import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent, type AgentTool } from "../src/agent/index.ts";
import {
  AssistantMessage,
  Message,
  type Model,
  registerFauxProvider,
  resetProviderRegistration,
  resetRegistry,
  text,
  thinking,
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

function passSchema() {
  return {
    jsonSchema: { type: "object", properties: {} },
    validate(v: unknown) {
      return { ok: true as const, value: (v ?? {}) as Record<string, unknown> };
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

function toolEnds(events: AgentEvent[]) {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end",
  );
}

function blockingTool(name: string, onStart: () => void): AgentTool {
  return {
    name,
    description: `${name} blocks until its signal aborts`,
    parameters: passSchema(),
    execute(_id, _params, signal) {
      onStart();
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error(`${name}: aborted`));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error(`${name}: aborted`)), {
          once: true,
        });
      });
    },
  };
}

describe("tool-scoped abort (placeholder plumbing)", () => {
  test("abortToolCall aborts ONE call of a parallel batch; the sibling completes; the run continues", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("s1", "slow", {}), toolCall("f1", "fast", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done")] }),
    ]);
    let releaseStarted = () => {};
    const started = new Promise<void>((r) => {
      releaseStarted = r;
    });
    const slow = blockingTool("slow", () => releaseStarted());
    const fast: AgentTool = {
      name: "fast",
      description: "returns immediately",
      parameters: passSchema(),
      async execute() {
        return { content: [text("fast done")] };
      },
    };
    const agent = new Agent({ model: reg.getModel(), tools: [slow, fast] });
    const events = collect(agent);

    const p = agent.prompt("go");
    await started;
    let unknownResult: boolean | null = null;
    let slowResult: boolean | null = null;
    let thrown: unknown = null;
    try {
      unknownResult = agent.abortToolCall("nope");
      slowResult = agent.abortToolCall("s1");
    } catch (exc) {
      thrown = exc;
      agent.abort();
    }
    await p;

    expect(thrown).toBeNull();
    expect(unknownResult).toBe(false);
    expect(slowResult).toBe(true);

    const ends = toolEnds(events);
    const slowEnd = ends.find((e) => e.toolCallId === "s1")!;
    const fastEnd = ends.find((e) => e.toolCallId === "f1")!;
    expect(slowEnd.isError).toBe(true);
    expect((slowEnd.result?.content[0] as { text: string }).text).toContain("slow: aborted");
    expect(fastEnd.isError).toBe(false);
    expect((fastEnd.result?.content[0] as { text: string }).text).toBe("fast done");

    const last = agent.agentState.messages[agent.agentState.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.textContent).toBe("done");

    expect(agent.agentState.toolAbortScopes.size).toBe(0);
    expect(agent.abortToolCall("s1")).toBe(false);
    reg.unregister();
  });

  test("registry lifecycle: a scope exists exactly while its tool runs and is dropped after", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("g1", "gate", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("done")] }),
    ]);
    let releaseStarted = () => {};
    const started = new Promise<void>((r) => {
      releaseStarted = r;
    });
    let release = () => {};
    const gate: AgentTool = {
      name: "gate",
      description: "resolves when released",
      parameters: passSchema(),
      execute() {
        releaseStarted();
        return new Promise((resolve) => {
          release = () => resolve({ content: [text("gated done")] });
        });
      },
    };
    const agent = new Agent({ model: reg.getModel(), tools: [gate] });

    const p = agent.prompt("go");
    await started;
    expect(agent.agentState.toolAbortScopes?.has("g1") ?? false).toBe(true);
    release();
    await p;

    expect(agent.agentState.toolAbortScopes?.size ?? -1).toBe(0);
    reg.unregister();
  });

  test("abortToolCall on an unknown id returns false while idle", () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const agent = new Agent({ model: reg.getModel(), tools: [] });
    expect(agent.abortToolCall("never-ran")).toBe(false);
    reg.unregister();
  });

  test("run-level abort() still cancels in-flight tools and stops the run (Esc path)", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    reg.setResponses([
      new AssistantMessage({
        content: [toolCall("s1", "slow", {})],
        stop_reason: "toolUse",
      }),
      new AssistantMessage({ content: [text("never reached")] }),
    ]);
    let releaseStarted = () => {};
    const started = new Promise<void>((r) => {
      releaseStarted = r;
    });
    const slow = blockingTool("slow", () => releaseStarted());
    const agent = new Agent({ model: reg.getModel(), tools: [slow] });
    const events = collect(agent);

    const p = agent.prompt("go");
    await started;
    agent.abort();
    await p;

    const ends = toolEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
    expect((ends[0]!.result?.content[0] as { text: string }).text).toContain("slow: aborted");

    const assistants = agent.agentState.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    const last = agent.agentState.messages[agent.agentState.messages.length - 1]!;
    expect(last.role).toBe("toolResult");
    reg.unregister();
  });
});

describe("replay_guard.classifyRungOutput", () => {
  async function classify(messages: Message[], fromIdx: number): Promise<string> {
    const mod = await import("../src/minima/replay_guard.ts");
    return mod.classifyRungOutput(messages, fromIdx);
  }

  const user = new Message({ role: "user", content: "task" });
  const emptyError = new AssistantMessage({
    content: [text("")],
    stop_reason: "error",
    error_message: "boom",
  });
  const partialError = new AssistantMessage({
    content: [text("partial words")],
    stop_reason: "error",
    error_message: "boom",
  });
  const answer = new AssistantMessage({ content: [text("hello")] });
  const thinkingOnly = new AssistantMessage({ content: [thinking("pondering")] });
  const toolUseOnly = new AssistantMessage({
    content: [toolCall("t1", "echo", {})],
    stop_reason: "toolUse",
  });
  const toolResult = new Message({
    role: "toolResult",
    tool_call_id: "t1",
    tool_name: "echo",
    content: [text("ok")],
  });
  const blockedToolResult = new Message({
    role: "toolResult",
    tool_call_id: "t1",
    tool_name: "bash",
    content: [text("blocked")],
    is_error: true,
  });

  test("empty window -> clean", async () => {
    expect(await classify([user], 1)).toBe("clean");
  });

  test("only an empty-content error assistant -> clean (provider hard-fail shape)", async () => {
    expect(await classify([user, emptyError], 1)).toBe("clean");
  });

  test("toolUse assistant whose calls never reached the dispatcher -> clean", async () => {
    expect(await classify([user, toolUseOnly], 1)).toBe("clean");
  });

  test("error assistant with partial streamed text -> text_only", async () => {
    expect(await classify([user, partialError], 1)).toBe("text_only");
  });

  test("plain text answer -> text_only", async () => {
    expect(await classify([user, answer], 1)).toBe("text_only");
  });

  test("thinking-only assistant -> text_only", async () => {
    expect(await classify([user, thinkingOnly], 1)).toBe("text_only");
  });

  test("any toolResult in the window -> effectful", async () => {
    expect(await classify([user, toolUseOnly, toolResult, emptyError], 1)).toBe("effectful");
  });

  test("a hook-blocked error toolResult still counts -> effectful", async () => {
    expect(await classify([user, toolUseOnly, blockedToolResult], 1)).toBe("effectful");
  });

  test("fromIdx bounds the window: earlier toolResults never leak in", async () => {
    expect(await classify([user, toolUseOnly, toolResult, user, emptyError], 3)).toBe("clean");
  });
});
