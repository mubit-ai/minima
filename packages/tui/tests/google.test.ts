import { describe, expect, test } from "bun:test";
import {
  complete,
  context,
  Message,
  registerProvider,
  resetProviderRegistration,
  resetRegistry,
  stream,
  type Model,
} from "../src/ai/index.ts";
import { GoogleProvider, type GoogleChunk, type GoogleClientLike } from "../src/ai/providers/google.ts";

const MODEL: Model = {
  id: "gemini-2.5-flash",
  provider: "google",
  api: "google-generative-ai",
  name: "Gemini Flash",
  cost: { input: 0.3, output: 2.5 },
  context_window: 1_000_000,
  max_tokens: 8192,
  reasoning: true,
};

function fakeClient(chunks: GoogleChunk[]): GoogleClientLike {
  return {
    models: {
      async generateContentStream(_opts: Record<string, unknown>): Promise<AsyncIterable<GoogleChunk>> {
        async function* gen(): AsyncIterable<GoogleChunk> {
          for (const c of chunks) yield c;
        }
        return gen();
      },
    },
  };
}

function resetAll() {
  resetRegistry();
  resetProviderRegistration();
}

describe("GoogleProvider", () => {
  test("assembles text deltas and folds usage into cost", async () => {
    resetAll();
    registerProvider("google-generative-ai", new GoogleProvider(fakeClient([
      {
        usage_metadata: { prompt_token_count: 8, candidates_token_count: 3, cached_content_token_count: 2 },
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }, { text: ", world" }],
            },
          },
        ],
      },
      { candidates: [{ finish_reason: "STOP" }] },
    ])));

    const types: string[] = [];
    const s = stream(MODEL, context({ messages: [new Message({ role: "user", content: "hi" })] }));
    for await (const ev of s) types.push(ev.type);
    const result = await s.result();

    expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(result.textContent).toBe("Hello, world");
    expect(result.stop_reason).toBe("stop");
    expect(result.usage.input).toBe(8);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cache_read).toBe(2);
    expect(result.usage.cost.total).toBeCloseTo((8 * 0.3 + 3 * 2.5) / 1_000_000, 10);
  });

  test("emits a full toolcall_end for a function_call part and sets toolUse", async () => {
    resetAll();
    registerProvider("google-generative-ai", new GoogleProvider(fakeClient([
      {
        usage_metadata: { prompt_token_count: 5, candidates_token_count: 1 },
        candidates: [
          {
            content: {
              parts: [{ function_call: { name: "bash", args: { command: "ls" } } }],
            },
          },
        ],
      },
      { candidates: [{ finish_reason: "STOP" }] },
    ])));

    const result = await complete(MODEL, context({ messages: [new Message({ role: "user", content: "run ls" })] }));
    expect(result.stop_reason).toBe("toolUse");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
    expect(result.toolCalls[0].arguments).toEqual({ command: "ls" });
  });

  test("captures thoughts as thinking when include_thoughts is on", async () => {
    resetAll();
    registerProvider("google-generative-ai", new GoogleProvider(fakeClient([
      {
        usage_metadata: { prompt_token_count: 1, candidates_token_count: 1, thoughts_token_count: 4 },
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "reasoning" }, { text: "answer" }],
            },
          },
        ],
      },
      { candidates: [{ finish_reason: "STOP" }] },
    ])));

    const result = await complete(MODEL, context({ messages: [new Message({ role: "user", content: "x" })] }));
    expect(result.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    // thought tokens are folded into output.
    expect(result.usage.output).toBe(5);
  });

  test("surfaces a thrown stream error as an error event", async () => {
    resetAll();
    const throwingClient: GoogleClientLike = {
      models: {
        async generateContentStream() {
          throw new Error("quota exceeded");
        },
      },
    };
    registerProvider("google-generative-ai", new GoogleProvider(throwingClient));
    const result = await complete(MODEL, context({ messages: [new Message({ role: "user", content: "x" })] }));
    expect(result.stop_reason).toBe("error");
    expect(result.error_message).toMatch(/quota exceeded/);
  });
});
