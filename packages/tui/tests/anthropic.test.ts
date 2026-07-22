import { describe, expect, test } from "bun:test";
import {
  stream,
  Message,
  type Model,
  complete,
  context,
  registerProvider,
  resetProviderRegistration,
  resetRegistry,
} from "../src/ai/index.ts";
import {
  type AnthropicClientLike,
  AnthropicProvider,
  type AnthropicStreamEvent,
  sdkTimeoutMs,
} from "../src/ai/providers/anthropic.ts";

const MODEL: Model = {
  id: "claude-haiku-4-5",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "Claude Haiku",
  cost: { input: 1, output: 5 },
  context_window: 200_000,
  max_tokens: 8192,
  reasoning: true,
};

function fakeClient(
  events: AnthropicStreamEvent[],
  captured?: Record<string, unknown>[],
): AnthropicClientLike {
  return {
    messages: {
      stream: (opts: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent> => {
        captured?.push(opts);
        async function* gen(): AsyncIterable<AnthropicStreamEvent> {
          for (const e of events) yield e;
        }
        return gen();
      },
    },
  };
}

const TEXT_EVENTS: AnthropicStreamEvent[] = [
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

async function kwargsFor(
  model: Model,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  resetAll();
  const captured: Record<string, unknown>[] = [];
  registerProvider("anthropic-messages", new AnthropicProvider(fakeClient(TEXT_EVENTS, captured)));
  await complete(model, context({ messages: [new Message({ role: "user", content: "x" })] }), {
    options,
  });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}


function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

describe("AnthropicProvider", () => {
  test("assembles a text reply from message_start/delta/stop events", async () => {
    resetAll();
    registerProvider(
      "anthropic-messages",
      new AnthropicProvider(
        fakeClient([
          {
            type: "message_start",
            message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const types: string[] = [];
    const s = stream(MODEL, context({ messages: [new Message({ role: "user", content: "hi" })] }));
    for await (const ev of s) types.push(ev.type);
    const result = await s.result();

    expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(result.textContent).toBe("Hello, world");
    expect(result.stop_reason).toBe("stop");
    expect(result.usage.input).toBe(12);
    expect(result.usage.output).toBe(5);
    expect(result.usage.cache_read).toBe(3);
    // cost: 12 * 1 + 5 * 5 per mtok
    expect(result.usage.cost.total).toBeCloseTo((12 * 1 + 5 * 5) / 1_000_000, 10);
  });

  test("assembles a tool call and maps stop to toolUse", async () => {
    resetAll();
    registerProvider(
      "anthropic-messages",
      new AnthropicProvider(
        fakeClient([
          { type: "message_start", message: { usage: { input_tokens: 10 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "c1", name: "bash" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"comm' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: 'and":"ls"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 8 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await complete(
      MODEL,
      context({ messages: [new Message({ role: "user", content: "run ls" })] }),
    );
    expect(result.stop_reason).toBe("toolUse");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].arguments).toEqual({ command: "ls" });
  });

  test("captures thinking + signature and replays it", async () => {
    resetAll();
    registerProvider(
      "anthropic-messages",
      new AnthropicProvider(
        fakeClient([
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Hmm" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig123" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      ),
    );

    const result = await complete(
      MODEL,
      context({ messages: [new Message({ role: "user", content: "x" })] }),
    );
    expect(result.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect((result.content[0] as { signature?: string }).signature).toBe("sig123");
    expect(result.textContent).toBe("ok");
  });

  test("adaptive-thinking model never gets enabled/budget_tokens; plain reasoning does", async () => {
    // claude-fable-5 has always-on adaptive thinking and 400s on enabled+budget_tokens.
    resetAll();
    const captured: Record<string, unknown>[] = [];
    registerProvider("anthropic-messages", new AnthropicProvider(fakeClient(TEXT_EVENTS, captured)));
    const fable: Model = { ...MODEL, id: "claude-fable-5", adaptive_thinking: true };
    const opts = { options: { thinking: true, thinking_budget: 2048 } };
    await complete(fable, context({ messages: [new Message({ role: "user", content: "x" })] }), opts);
    expect(captured[0].thinking).toEqual({ type: "adaptive" });

    await complete(MODEL, context({ messages: [new Message({ role: "user", content: "x" })] }), opts);
    expect(captured[1].thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  test("converts the seconds-based timeout option to SDK milliseconds", () => {
    // Regression: seconds passed straight to the SDK (ms) gave every request a
    // 30-60ms deadline — all live Claude calls failed with "Request timed out".
    expect(sdkTimeoutMs({})).toBe(60_000);
    expect(sdkTimeoutMs({ timeout: 30 })).toBe(30_000);
    expect(sdkTimeoutMs({ timeout: 0.5 })).toBe(500);
  });

  test("unflagged reasoning model gets enabled + budget_tokens", async () => {
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]) {
      const kwargs = await kwargsFor(
        { ...MODEL, id },
        { thinking: true, thinking_budget: 2048, thinking_level: "high" },
      );
      expect(kwargs.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
      expect(kwargs.output_config).toBeUndefined();
    }
  });

  test("adaptive_thinking model gets adaptive + output_config.effort, no budget_tokens", async () => {
    for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5"]) {
      const kwargs = await kwargsFor(
        { ...MODEL, id, adaptive_thinking: true },
        { thinking: true, thinking_budget: 2048, thinking_level: "high" },
      );
      expect(kwargs.thinking).toEqual({ type: "adaptive" });
      expect(kwargs.output_config).toEqual({ effort: "high" });
    }
  });

  test("adaptive_thinking model without a level omits output_config", async () => {
    const kwargs = await kwargsFor(
      { ...MODEL, id: "claude-opus-4-8", adaptive_thinking: true },
      { thinking: true, thinking_budget: 2048 },
    );
    expect(kwargs.thinking).toEqual({ type: "adaptive" });
    expect(kwargs.output_config).toBeUndefined();
  });

  test("non-reasoning model gets no thinking kwargs", async () => {
    const kwargs = await kwargsFor(
      { ...MODEL, id: "claude-opus-4-8", adaptive_thinking: true, reasoning: false },
      { thinking: true, thinking_budget: 2048, thinking_level: "high" },
    );
    expect(kwargs.thinking).toBeUndefined();
    expect(kwargs.output_config).toBeUndefined();
  });

  test("thinking off sends no thinking kwargs on any format", async () => {
    for (const model of [
      { ...MODEL, id: "claude-haiku-4-5" },
      { ...MODEL, id: "claude-opus-4-8", adaptive_thinking: true },
    ]) {
      const kwargs = await kwargsFor(model, {});
      expect(kwargs.thinking).toBeUndefined();
      expect(kwargs.output_config).toBeUndefined();
    }
  });

  test("surfaces a thrown stream error as an error event", async () => {
    resetAll();
    const throwingClient: AnthropicClientLike = {
      messages: {
        stream: () => {
          throw new Error("401 invalid key");
        },
      },
    };
    registerProvider("anthropic-messages", new AnthropicProvider(throwingClient));
    const result = await complete(
      MODEL,
      context({ messages: [new Message({ role: "user", content: "x" })] }),
    );
    expect(result.stop_reason).toBe("error");
    expect(result.error_message).toMatch(/401 invalid key/);
  });
});
