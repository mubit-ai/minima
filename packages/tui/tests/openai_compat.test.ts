import { describe, expect, test } from "bun:test";
import {
  AssistantMessage,
  Message,
  OpenAICompatProvider,
  complete,
  context,
  getProvider,
  registerProvider,
  resetProviderRegistration,
  resetRegistry,
  stream,
  text,
  type Model,
} from "../src/ai/index.ts";

const OPENAI_MODEL: Model = {
  id: "gpt-4o-mini",
  provider: "openai",
  api: "openai-completions",
  name: "GPT-4o mini",
  cost: { input: 0.15, output: 0.6 },
  context_window: 128_000,
  max_tokens: 16_384,
};

/** Build a fake fetch that returns a streaming SSE body. */
function sseFetch(chunks: string[]) {
  return async (_url: string, _init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    return { status: 200, ok: true, body };
  };
}

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

describe("OpenAICompatProvider self-registers", () => {
  test("ensureProvidersRegistered registers the openai-completions provider", () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    expect(getProvider("openai-completions")).toBeInstanceOf(OpenAICompatProvider);
  });
});

describe("openai-compat SSE streaming", () => {
  test("assembles text deltas and emits done with usage", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());

    const chunks = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: ", world" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const s = stream(OPENAI_MODEL, context({ messages: [new Message({ role: "user", content: "hi" })] }), {
      options: { fetch: sseFetch(chunks) },
    });

    const types: string[] = [];
    for await (const ev of s) types.push(ev.type);
    const result = await s.result();

    expect(types).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result.textContent).toBe("Hello, world");
    expect(result.stop_reason).toBe("stop");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(5);
    // total = (input tokens x input price) + (output tokens x output price), per-mtok
    expect(result.usage.cost.total).toBeCloseTo((10 * 0.15 + 5 * 0.6) / 1_000_000, 10);
  });

  test("assembles tool calls from partial JSON and maps finish to toolUse", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());

    const chunks = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "bash", arguments: '{"comm' } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const result = await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "run ls" })] }),
      { options: { fetch: sseFetch(chunks) } },
    );

    expect(result.stop_reason).toBe("toolUse");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].arguments).toEqual({ command: "ls" });
  });

  test("emits thinking deltas from reasoning_content (deepseek-style)", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());

    const chunks = [
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "Hmm" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const result = await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "x" })] }),
      { options: { fetch: sseFetch(chunks) } },
    );

    expect(result.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.textContent).toBe("ok");
  });

  test("surfaces a non-2xx response as an error event", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());

    const failingFetch = async () => ({ status: 401, ok: false, body: null });
    const result = await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "x" })] }),
      { options: { fetch: failingFetch } },
    );

    expect(result.stop_reason).toBe("error");
    expect(result.error_message).toMatch(/HTTP 401/);
  });
});
