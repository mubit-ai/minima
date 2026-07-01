import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  Stream,
  attachCost,
  complete,
  context,
  done as doneEv,
  getProvider,
  registerFauxProvider,
  resetRegistry,
  resetProviderRegistration,
  stream,
  text,
  toolCall,
  type Model,
} from "../src/ai/index.ts";

const FAUX_MODEL: Model = {
  id: "faux",
  provider: "faux",
  api: "faux",
  name: "Faux",
  cost: { input: 1, output: 2 },
  context_window: 8192,
  max_tokens: 4096,
};

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

describe("Stream", () => {
  test("forwards events from the underlying async iterable", async () => {
    const msg = new AssistantMessage({ content: [text("hi")] });
    async function* gen() {
      yield doneEv("stop", msg);
    }
    const s = new Stream(gen());
    const events = [];
    for await (const ev of s) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("done");
    expect(await s.result()).toBe(msg);
  });

  test("result() drains and returns the assistant message", async () => {
    const msg = new AssistantMessage({ content: [text("hello world")] });
    async function* gen() {
      yield { type: "start", partial: undefined };
      yield doneEv("stop", msg);
    }
    const s = new Stream(gen());
    expect(await s.result()).toBe(msg);
    expect(s.isConsumed).toBe(true);
  });

  test("throws if stream ends without done/error", async () => {
    async function* gen() {
      yield { type: "start", partial: undefined };
    }
    const s = new Stream(gen());
    await expect(s.result()).rejects.toThrow(/without a done\/error event/);
  });
});

describe("faux provider", () => {
  test("replays a queued assistant message as a full event stream", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const reply = new AssistantMessage({
      content: [text("pong")],
      stop_reason: "stop",
    });
    reg.setResponses([reply]);

    const s = stream(FAUX_MODEL, context({ messages: [] }));
    const types: string[] = [];
    for await (const ev of s) types.push(ev.type);

    expect(types).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    reg.unregister();
  });

  test("emits toolCall events for a tool-use message", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const reply = new AssistantMessage({
      content: [toolCall("call_1", "bash", { command: "echo hi" })],
      stop_reason: "toolUse",
    });
    reg.setResponses([reply]);

    const result = await complete(FAUX_MODEL, context({ messages: [] }));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.stop_reason).toBe("toolUse");
    reg.unregister();
  });

  test("errors when no responses are queued", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const s = stream(FAUX_MODEL, context({ messages: [] }));
    const result = await s.result();
    expect(result.stop_reason).toBe("error");
    expect(result.error_message).toMatch(/No more faux responses queued/);
    reg.unregister();
  });

  test("increments call_count per stream and estimates output tokens", async () => {
    resetAll();
    const reg = registerFauxProvider([FAUX_MODEL]);
    const reply = new AssistantMessage({ content: [text("a".repeat(40))] });
    reg.setResponses([reply, new AssistantMessage({ content: [text("b")] })]);

    await complete(FAUX_MODEL, context({ messages: [] }));
    await complete(FAUX_MODEL, context({ messages: [] }));
    expect(reg.state.callCount).toBe(2);
    // 40 chars / 4 = 10 tokens estimated on the first (un-priced) message.
    expect(reg.state.responses).toHaveLength(0);
    reg.unregister();
  });

  test("attachCost folds all four cost components into total", () => {
    const model: Model = {
      id: "m",
      provider: "p",
      api: "faux",
      name: "m",
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
      context_window: 1000,
      max_tokens: 1000,
    };
    const msg = new AssistantMessage({ content: [text("x")] });
    msg.usage.input = 1_000_000; // 1 mtok
    msg.usage.output = 1_000_000;
    msg.usage.cache_read = 1_000_000;
    msg.usage.cache_write = 1_000_000;
    attachCost(model, msg.usage);
    expect(msg.usage.cost.total).toBeCloseTo(1 + 2 + 0.1 + 1.25, 5);
  });

  test("getProvider throws for an unknown api id", () => {
    resetAll();
    expect(() => getProvider("anthropic-messages")).toThrow(/no provider registered/);
  });
});
