import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  registerFauxProvider,
  registerModel,
  resetModelRegistry,
  resetProviderRegistration,
  resetRegistry,
  text,
  thinking,
  type Model,
} from "../src/ai/index.ts";
import { Agent } from "../src/agent/agent.ts";
import type { AgentEvent } from "../src/agent/events.ts";

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
    const last1 = agent.agentState.messages[agent.agentState.messages.length - 1] as AssistantMessage;
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
    const last2 = agent.agentState.messages[agent.agentState.messages.length - 1] as AssistantMessage;
    expect(last2.content.some((b) => b.type === "thinking")).toBe(false);
    expect(last2.textContent).toBe("response 2");

    reg.unregister();
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

    const lastMsg = agent.agentState.messages[agent.agentState.messages.length - 1] as AssistantMessage;
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

    const lastMsg = agent.agentState.messages[agent.agentState.messages.length - 1] as AssistantMessage;
    expect(lastMsg.stop_reason).toBe("error");
    expect(lastMsg.error_message).toBe("API rate limit exceeded");

    reg.unregister();
  });
});
