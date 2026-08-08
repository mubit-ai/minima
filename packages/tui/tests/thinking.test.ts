import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { effectiveEffort, reasoningPayload } from "../src/ai/provider_quirks.ts";
import {
  AssistantMessage,
  type Model,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  thinking,
} from "../src/ai/index.ts";

const FAUX_MODEL_REASONING: Model = {
  id: "test-reasoning",
  provider: "faux",
  api: "faux",
  name: "Test Reasoning",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
  reasoning: true,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
  resetModelRegistry();
}

function captureEvents(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((ev) => {
    events.push(ev);
  });
  return events;
}

describe("Thinking mode event flow", () => {
  test("thinking ON: emits thinking_start, thinking_delta, thinking_end, then text", async () => {
    resetAll();
    registerModel(FAUX_MODEL_REASONING);
    const reg = registerFauxProvider([FAUX_MODEL_REASONING]);

    // A response with a thinking block followed by a text block
    const reply = new AssistantMessage({
      content: [thinking("Let me compute 6*7=42"), text("The answer is 42")],
      stop_reason: "stop",
    });
    reg.setResponses([reply]);

    const agent = new Agent({ model: FAUX_MODEL_REASONING, thinkingLevel: "medium", tools: [] });
    const events = captureEvents(agent);

    await agent.prompt("what is 6*7?");

    const updateEvents = events.filter((e) => e.type === "message_update");
    const streamTypes = updateEvents.map((e) => {
      if (e.type === "message_update") return e.assistantMessageEvent?.type;
      return undefined;
    });

    expect(streamTypes).toContain("thinking_start");
    expect(streamTypes).toContain("thinking_delta");
    expect(streamTypes).toContain("thinking_end");
    expect(streamTypes).toContain("text_start");
    expect(streamTypes).toContain("text_delta");

    // Thinking events come before text events
    const firstThinking = streamTypes.indexOf("thinking_start");
    const firstText = streamTypes.indexOf("text_start");
    expect(firstThinking).toBeLessThan(firstText);

    // The final assistant message has both thinking and text content
    const lastMsg = agent.agentState.messages[agent.agentState.messages.length - 1];
    expect(lastMsg).toBeInstanceOf(AssistantMessage);
    expect(lastMsg.textContent).toBe("The answer is 42");

    reg.unregister();
  });

  test("thinking OFF: emits only text events, no thinking events", async () => {
    resetAll();
    registerModel(FAUX_MODEL_REASONING);
    const reg = registerFauxProvider([FAUX_MODEL_REASONING]);

    const reply = new AssistantMessage({
      content: [text("hello world")],
      stop_reason: "stop",
    });
    reg.setResponses([reply]);

    const agent = new Agent({ model: FAUX_MODEL_REASONING, thinkingLevel: "off", tools: [] });
    const events = captureEvents(agent);

    await agent.prompt("hi");

    const updateEvents = events.filter((e) => e.type === "message_update");
    const streamTypes = updateEvents.map((e) => {
      if (e.type === "message_update") return e.assistantMessageEvent?.type;
      return undefined;
    });

    expect(streamTypes).not.toContain("thinking_start");
    expect(streamTypes).not.toContain("thinking_delta");
    expect(streamTypes).toContain("text_delta");
    expect(agent.agentState.thinkingLevel).toBe("off");

    reg.unregister();
  });

  test("toggling thinkingLevel off at runtime stops thinking on next turn", async () => {
    resetAll();
    registerModel(FAUX_MODEL_REASONING);
    const reg = registerFauxProvider([FAUX_MODEL_REASONING]);

    // Turn 1: with thinking
    reg.setResponses([
      new AssistantMessage({
        content: [thinking("hmm"), text("response 1")],
        stop_reason: "stop",
      }),
    ]);

    const agent = new Agent({ model: FAUX_MODEL_REASONING, thinkingLevel: "medium", tools: [] });

    await agent.prompt("turn 1");
    const last1 = agent.agentState.messages[
      agent.agentState.messages.length - 1
    ] as AssistantMessage;
    expect(last1.content.some((b) => b.type === "thinking")).toBe(true);

    // Toggle off
    agent.agentState.thinkingLevel = "off";
    expect(agent.agentState.thinkingLevel).toBe("off");

    // Turn 2: without thinking
    reg.setResponses([
      new AssistantMessage({
        content: [text("response 2")],
        stop_reason: "stop",
      }),
    ]);

    await agent.prompt("turn 2");
    const last2 = agent.agentState.messages[
      agent.agentState.messages.length - 1
    ] as AssistantMessage;
    expect(last2.content.some((b) => b.type === "thinking")).toBe(false);
    expect(last2.textContent).toBe("response 2");

    reg.unregister();
  });
});

// effectiveEffort is the ONE answer both the wire and the status bar read (MUB-229). These
// assert the returned pair, never how the ladder branches internally.
describe("effectiveEffort — the precedence ladder", () => {
  const reasoner = { provider: "openai", reasoning: true };

  test("rung 1: requires_explicit_effort_off wins over everything, tools or not", () => {
    const m = { ...reasoner, requires_explicit_effort_off: true, tools_require_effort_none: true };
    expect(effectiveEffort(m, true, "high")).toEqual({ send: "none", state: "off" });
    expect(effectiveEffort(m, false, undefined)).toEqual({ send: "none", state: "off" });
  });

  test("rung 2: tools_require_effort_none pins none WITH tools, and only with tools", () => {
    const m = { ...reasoner, tools_require_effort_none: true };
    expect(effectiveEffort(m, true, "high")).toEqual({ send: "none", state: "pinned-none" });
    // Tool-less and no level requested: the model's own default, not "none" (#328's scope).
    expect(effectiveEffort(m, false, undefined)).toEqual({ send: undefined, state: "default" });
  });

  test("rung 3: a set level is honoured when the host accepts it", () => {
    expect(effectiveEffort(reasoner, false, "low")).toEqual({ send: "low", state: "honoured" });
    expect(effectiveEffort(reasoner, false, "medium")).toEqual({
      send: "medium",
      state: "honoured",
    });
    expect(effectiveEffort(reasoner, false, "high")).toEqual({ send: "high", state: "honoured" });
  });

  // Verified live 2026-08-05: gpt-5.6-{sol,terra,luna} answer "Unsupported value:
  // 'reasoning_effort' does not support 'minimal'". xhigh IS accepted there, but the
  // conservative default clamp holds for every unverified openai-compat host until a
  // model declares effort_levels.
  test("rung 3: levels outside the host vocabulary clamp instead of reaching the wire", () => {
    expect(effectiveEffort(reasoner, false, "xhigh")).toEqual({ send: "high", state: "clamped" });
    expect(effectiveEffort(reasoner, false, "minimal")).toEqual({ send: "low", state: "clamped" });
  });

  test("Model.effort_levels widens the clamp, and [] opts the model out entirely", () => {
    const wide = { ...reasoner, effort_levels: ["low", "medium", "high", "xhigh"] };
    expect(effectiveEffort(wide, false, "xhigh")).toEqual({ send: "xhigh", state: "honoured" });
    const optedOut = { ...reasoner, effort_levels: [] };
    expect(effectiveEffort(optedOut, false, "high")).toEqual({ send: undefined, state: "default" });
  });

  test("rung 4: no level, an unknown level, or `off` sends nothing", () => {
    expect(effectiveEffort(reasoner, false, undefined)).toEqual({
      send: undefined,
      state: "default",
    });
    expect(effectiveEffort(reasoner, false, "off")).toEqual({ send: undefined, state: "default" });
    expect(effectiveEffort(reasoner, false, "turbo")).toEqual({
      send: undefined,
      state: "default",
    });
    expect(effectiveEffort(reasoner, false, 3)).toEqual({ send: undefined, state: "default" });
  });

  // Fail-closed, same doctrine as supportsImageInput. Verified live 2026-08-05: gpt-4o and
  // gpt-4o-mini answer "Unrecognized request argument supplied: reasoning_effort" at EVERY
  // value, "none" included — so an undeclared model must never receive the parameter.
  test("a model that does not declare reasoning never receives an effort", () => {
    expect(effectiveEffort({ provider: "openai" }, true, "high")).toEqual({
      send: undefined,
      state: "default",
    });
    // Declared non-reasoning is a stronger statement than unknown: reasoning is genuinely off.
    expect(effectiveEffort({ provider: "openai", reasoning: false }, true, "high")).toEqual({
      send: undefined,
      state: "off",
    });
  });

  // Verified live 2026-08-05 on claude-opus-4-8 / claude-sonnet-5 / claude-fable-5:
  // output_config.effort accepts low|medium|high|xhigh and 400s on minimal and none.
  test("anthropic keeps its wider vocabulary — xhigh reaches the wire, minimal still clamps", () => {
    const claude = { provider: "anthropic", reasoning: true };
    expect(effectiveEffort(claude, true, "xhigh")).toEqual({ send: "xhigh", state: "honoured" });
    expect(effectiveEffort(claude, true, "minimal")).toEqual({ send: "low", state: "clamped" });
  });
});

describe("reasoningPayload — the wire SHAPE is per-provider data", () => {
  test("openai-compat baseline: a flat reasoning_effort key", () => {
    expect(reasoningPayload("openai", "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningPayload("openai", "none")).toEqual({ reasoning_effort: "none" });
    expect(reasoningPayload("openai", undefined)).toEqual({});
  });

  test("openrouter speaks its own nested reasoning object", () => {
    expect(reasoningPayload("openrouter", "high")).toEqual({ reasoning: { effort: "high" } });
    expect(reasoningPayload("openrouter", "none")).toEqual({ reasoning: { enabled: false } });
  });

  // Anthropic has no off value at all (verified: output_config.effort 400s on "none"), so a
  // flagged anthropic model sends nothing rather than a payload the API refuses.
  test("anthropic nests under output_config and cannot express off", () => {
    expect(reasoningPayload("anthropic", "high")).toEqual({ output_config: { effort: "high" } });
    expect(reasoningPayload("anthropic", "none")).toEqual({});
  });
});

describe("Error surfacing", () => {
  test("provider error produces stop_reason=error with error_message on the assistant message", async () => {
    resetAll();
    registerModel(FAUX_MODEL_REASONING);
    const reg = registerFauxProvider([FAUX_MODEL_REASONING]);

    // No responses queued -> faux provider yields an error event
    const agent = new Agent({ model: FAUX_MODEL_REASONING, tools: [] });
    const events = captureEvents(agent);

    await agent.prompt("this will error");

    const lastMsg = agent.agentState.messages[
      agent.agentState.messages.length - 1
    ] as AssistantMessage;
    expect(lastMsg.stop_reason).toBe("error");
    expect(lastMsg.error_message).toBeTruthy();
    expect(lastMsg.textContent.trim()).toBe("");

    // A turn_end event was emitted (the loop didn't hang)
    expect(events.some((e) => e.type === "turn_end")).toBe(true);

    reg.unregister();
  });

  test("thrown provider error surfaces as stop_reason=error (not a hang)", async () => {
    resetAll();
    registerModel(FAUX_MODEL_REASONING);
    const reg = registerFauxProvider([FAUX_MODEL_REASONING]);

    const errReply = new AssistantMessage({
      content: [text("")],
      stop_reason: "error",
      error_message: "API rate limit exceeded",
    });
    reg.setResponses([errReply]);

    const agent = new Agent({ model: FAUX_MODEL_REASONING, tools: [] });

    await agent.prompt("trigger error");

    const lastMsg = agent.agentState.messages[
      agent.agentState.messages.length - 1
    ] as AssistantMessage;
    expect(lastMsg.stop_reason).toBe("error");
    expect(lastMsg.error_message).toBe("API rate limit exceeded");

    reg.unregister();
  });
});
