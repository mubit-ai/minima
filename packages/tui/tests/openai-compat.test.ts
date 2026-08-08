import { describe, expect, test } from "bun:test";
import {
  stream,
  AssistantMessage,
  Message,
  type Model,
  type Tool,
  OpenAICompatProvider,
  complete,
  context,
  getProvider,
  registerProvider,
  resetProviderRegistration,
  resetRegistry,
  image,
  text,
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

    const s = stream(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      {
        options: { fetch: sseFetch(chunks) },
      },
    );

    const types: string[] = [];
    for await (const ev of s) types.push(ev.type);
    const result = await s.result();

    expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
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
    expect(result.toolCalls[0]?.name).toBe("bash");
    expect(result.toolCalls[0]?.arguments).toEqual({ command: "ls" });
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

  test("a chunk carrying both reasoning keys yields one thinking block, not two", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());

    const chunks = [
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: "Hmm", reasoning: "Hmm" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const s = stream(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "x" })] }),
      { options: { fetch: sseFetch(chunks) } },
    );
    const deltas: string[] = [];
    for await (const ev of s) {
      if (ev.type === "thinking_delta") deltas.push(ev.delta);
    }
    const result = await s.result();

    expect(deltas).toEqual(["Hmm"]);
    expect(result.content.filter((b) => b.type === "thinking")).toHaveLength(1);
    expect(result.content.find((b) => b.type === "thinking")).toMatchObject({ thinking: "Hmm" });
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

describe("openai-compat surfaces the provider's own error message", () => {
  /** A failing fetch whose body carries whatever the provider actually said. */
  function failingFetch(status: number, body: string) {
    return async () => ({ status, ok: false, body: null, text: async () => body });
  }

  async function errorOf(fetchImpl: unknown): Promise<string> {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    const result = await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      { options: { fetch: fetchImpl, api_key: "k" } },
    );
    return result.error_message ?? "";
  }

  test("the standard {error:{message}} envelope is unwrapped", async () => {
    const msg = await errorOf(
      failingFetch(429, JSON.stringify({ error: { message: "Rate limit reached, retry in 20s" } })),
    );
    expect(msg).toContain("HTTP 429");
    expect(msg).toContain("Rate limit reached, retry in 20s");
  });

  test("a bad request explains itself instead of reading as a bare 400", async () => {
    const msg = await errorOf(
      failingFetch(400, JSON.stringify({ error: { message: "max_tokens is too large" } })),
    );
    expect(msg).toContain("max_tokens is too large");
  });

  test("a non-JSON body (proxy HTML) is quoted raw rather than dropped", async () => {
    const msg = await errorOf(failingFetch(502, "<html>502 Bad Gateway</html>"));
    expect(msg).toContain("HTTP 502");
    expect(msg).toContain("502 Bad Gateway");
  });

  test("a huge body is capped so it cannot flood the TUI", async () => {
    const msg = await errorOf(failingFetch(500, "x".repeat(5000)));
    expect(msg.length).toBeLessThan(600);
    expect(msg).toContain("…");
  });

  test("an empty body still yields the bare status, and never throws", async () => {
    expect(await errorOf(failingFetch(503, ""))).toContain("HTTP 503");
  });

  test("a transport with no text() at all is unchanged (back-compat)", async () => {
    const msg = await errorOf(async () => ({ status: 401, ok: false, body: null }));
    expect(msg).toContain("HTTP 401");
  });

  test("a text() that throws degrades to the bare status", async () => {
    const msg = await errorOf(async () => ({
      status: 500,
      ok: false,
      body: null,
      text: async () => {
        throw new Error("body already consumed");
      },
    }));
    expect(msg).toContain("HTTP 500");
    expect(msg).not.toContain("already consumed");
  });
});

describe("openai-compat credits cached prompt tokens", () => {
  // prompt_tokens is INCLUSIVE of prompt_tokens_details.cached_tokens; billing the whole
  // prompt at the input rate is what inflates the realized cost fed to /v1/feedback.
  const CACHING_MODEL: Model = { ...OPENAI_MODEL, cost: { ...OPENAI_MODEL.cost, cache_read: 0.015 } };

  function usageChunks(usage: Record<string, unknown>) {
    return [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ];
  }

  async function usageOf(usage: Record<string, unknown>) {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    const result = await complete(
      CACHING_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      { options: { fetch: sseFetch(usageChunks(usage)) } },
    );
    return result.usage;
  }

  test("cached tokens bill at the cache rate, not the input rate", async () => {
    const usage = await usageOf({
      prompt_tokens: 1000,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 800 },
    });

    expect(usage.cache_read).toBe(800);
    expect(usage.input).toBe(200); // net of cache — prompt_tokens is inclusive
    expect(usage.cost.total).toBeCloseTo((200 * 0.15 + 5 * 0.6 + 800 * 0.015) / 1_000_000, 12);
  });

  test("a response with no cache details is unchanged", async () => {
    const usage = await usageOf({ prompt_tokens: 1000, completion_tokens: 5 });
    expect(usage.cache_read).toBe(0);
    expect(usage.input).toBe(1000);
  });

  test("cached_tokens larger than prompt_tokens cannot drive input negative", async () => {
    const usage = await usageOf({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 500 },
    });
    expect(usage.input).toBe(0);
  });
});

describe("openai-compat honours options.timeout", () => {
  /** Never resolves; rejects only when the request signal aborts. */
  function hangingFetch(seen: { signal?: AbortSignal | null }) {
    return (_url: string, init: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        seen.signal = init.signal;
        init.signal?.addEventListener("abort", () =>
          reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
        );
      });
  }

  test("a request that never responds is cut off at the deadline", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    const seen: { signal?: AbortSignal | null } = {};

    const result = await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      { options: { fetch: hangingFetch(seen), timeout: 0.05 } },
    );

    expect(result.stop_reason).toBe("error");
    expect(result.error_message ?? "").toMatch(/timed out|timeout|abort/i);
  });

  test("the caller's own signal still aborts when a deadline is also set", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    const seen: { signal?: AbortSignal | null } = {};
    const ac = new AbortController();
    const pending = complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      { options: { fetch: hangingFetch(seen), timeout: 300 }, signal: ac.signal },
    );
    ac.abort(new Error("user cancelled"));

    const result = await pending;
    expect(result.stop_reason).toBe("error");
    expect(result.error_message).toContain("user cancelled");
  });

  test("no timeout option leaves the request unbounded", async () => {
    resetAll();
    registerProvider("openai-completions", new OpenAICompatProvider());
    const seen: { signal?: AbortSignal | null } = {};

    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.signal = init.signal;
      return sseFetch(chunks)(url, init);
    };
    await complete(
      OPENAI_MODEL,
      context({ messages: [new Message({ role: "user", content: "hi" })] }),
      { options: { fetch: fetchImpl } },
    );

    expect(seen.signal).toBeUndefined();
  });
});

// OpenAI's chat-completions API accepts only `text` parts in a role:"tool" message, so
// ai/compat.ts hoists tool-result images into a following user message. These pin the
// resulting wire shape, including the ordering constraint the API actually enforces.
describe("OpenAICompatProvider — hoisted tool-result images", () => {
  const OK_SSE = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];

  function capturingFetch(captured: Record<string, unknown>[]) {
    const inner = sseFetch(OK_SSE);
    return async (url: string, init: RequestInit) => {
      captured.push(JSON.parse(String(init.body)));
      return inner(url, init);
    };
  }

  async function wireFor(messages: Message[]): Promise<Record<string, unknown>[]> {
    resetAll();
    const captured: Record<string, unknown>[] = [];
    registerProvider("openai-completions", new OpenAICompatProvider());
    await complete(OPENAI_MODEL, context({ messages }), {
      options: { fetch: capturingFetch(captured) },
    });
    return captured[0]!.messages as Record<string, unknown>[];
  }

  const imageToolResult = (id: string, path: string) =>
    new Message({
      role: "toolResult",
      content: [text(`[image] ${path}`), image("QUJD", "image/png")],
      tool_call_id: id,
    });

  test("the image is hoisted into a user message that follows the tool message", async () => {
    const wire = await wireFor([new Message({ role: "user", content: "look" }), imageToolResult("call_1", "x.png")]);
    expect(wire.map((m) => m.role)).toEqual(["user", "tool", "user"]);
    const hoisted = wire[2]!.content as Record<string, unknown>[];
    expect(hoisted[0]).toEqual({ type: "text", text: "[image output from the preceding tool result(s)]" });
    expect((hoisted[1] as { image_url: { url: string } }).image_url.url).toMatch(
      /^data:image\/png;base64,QUJD$/,
    );
  });

  test("the tool message content stays a string and carries no base64", async () => {
    const wire = await wireFor([new Message({ role: "user", content: "look" }), imageToolResult("call_1", "x.png")]);
    expect(typeof wire[1]!.content).toBe("string");
    expect(wire[1]!.content).toBe("[image] x.png");
    expect(String(wire[1]!.content)).not.toContain("QUJD");
  });

  // The API requires every role:"tool" message to sit in an unbroken run immediately after
  // the assistant message that carried the tool_calls — one hoisted message, after both.
  test("two parallel tool results yield exactly ONE hoisted message, after both", async () => {
    const wire = await wireFor([
      new Message({ role: "user", content: "look" }),
      imageToolResult("call_1", "a.png"),
      imageToolResult("call_2", "b.png"),
    ]);
    expect(wire.map((m) => m.role)).toEqual(["user", "tool", "tool", "user"]);
    expect((wire[3]!.content as unknown[]).filter((b) => (b as { type: string }).type === "image_url")).toHaveLength(2);
  });

  // The composer's Ctrl+V path: an image in a genuine USER message, with no hoist involved.
  test("a pasted image serializes as an image_url part beside its question", async () => {
    const wire = await wireFor([
      new Message({
        role: "user",
        content: [text("[Image #1] what is this"), image("QUJD", "image/png")],
      }),
    ]);
    expect(wire.map((m) => m.role)).toEqual(["user"]);
    const parts = wire[0]!.content as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "[Image #1] what is this" });
    expect((parts[1] as { image_url: { url: string } }).image_url.url).toBe(
      "data:image/png;base64,QUJD",
    );
  });
});

// gpt-5.6-* carry a non-"none" DEFAULT reasoning effort that /v1/chat/completions then
// refuses to combine with function tools, so the whole family 400s on every agent turn
// ("Function tools with reasoning_effort are not supported for <id> … or set
// reasoning_effort to 'none'"). Verified against the live API: bare + tools 400s, effort
// "none" + tools succeeds, and gpt-4o rejects the parameter outright — hence per-model.
describe("OpenAICompatProvider — reasoning_effort for models that refuse it with tools", () => {
  const EFFORT_MODEL: Model = { ...OPENAI_MODEL, id: "gpt-5.6-sol", tools_require_effort_none: true };

  const OK_SSE = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];

  const noopTool: Tool = {
    name: "noop",
    description: "does nothing",
    parameters: {
      jsonSchema: { type: "object", properties: {} },
      validate: (v) => ({ ok: true, value: (v ?? {}) as Record<string, unknown> }),
    },
  };

  /** The WHOLE request payload, not just its messages. */
  async function payloadFor(
    model: Model,
    tools: Tool[],
    thinkingLevel?: string,
  ): Promise<Record<string, unknown>> {
    resetAll();
    const captured: Record<string, unknown>[] = [];
    const inner = sseFetch(OK_SSE);
    registerProvider("openai-completions", new OpenAICompatProvider());
    await complete(model, context({ messages: [new Message({ role: "user", content: "hi" })], tools }), {
      options: {
        fetch: async (url: string, init: RequestInit) => {
          captured.push(JSON.parse(String(init.body)));
          return inner(url, init);
        },
        // What agent/loop.ts puts on the wire options once a thinking level is set.
        ...(thinkingLevel === undefined ? {} : { thinking: true, thinking_level: thinkingLevel }),
      },
    });
    return captured[0]!;
  }

  test("a flagged model sends reasoning_effort none alongside its tools", async () => {
    const payload = await payloadFor(EFFORT_MODEL, [noopTool]);
    expect(payload.reasoning_effort).toBe("none");
    expect(payload.tools).toHaveLength(1);
  });

  // The API refuses only the COMBINATION. A tool-less call (judge, classifier, --no-tools)
  // must keep the model's own default effort, or the quirk silently downgrades those too.
  test("the same model sends no reasoning_effort when there are no tools", async () => {
    const payload = await payloadFor(EFFORT_MODEL, []);
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  // gpt-4o answers "Unrecognized request argument supplied: reasoning_effort", so leaking the
  // key onto an unflagged model would break every non-reasoning OpenAI model at once.
  test("an unflagged model's payload is unchanged, key for key", async () => {
    const payload = await payloadFor(OPENAI_MODEL, [noopTool]);
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(Object.keys(payload).sort()).toEqual([
      "max_completion_tokens",
      "messages",
      "model",
      "stream",
      "stream_options",
      "tools",
    ]);
  });

  // Re-probed live 2026-08-05 on all three of gpt-5.6-{sol,terra,luna}: an explicit
  // "high" alongside tools 400s exactly like the bare default does, so rung 2 has to
  // outrank a requested level rather than lose to it.
  test("the tools pin outranks a requested level", async () => {
    const payload = await payloadFor(EFFORT_MODEL, [noopTool], "high");
    expect(payload.reasoning_effort).toBe("none");
  });
});

// MUB-229: before this, cycling the thinking level moved a coloured word in the status bar
// and sent NOTHING on openai, openrouter, xai, groq and deepseek. effortForLevel had exactly
// one caller, in the anthropic provider.
describe("OpenAICompatProvider — a thinking level reaches the wire", () => {
  const REASONER: Model = { ...OPENAI_MODEL, id: "gpt-5.6-luna", reasoning: true };

  const OK_SSE = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];

  const noopTool: Tool = {
    name: "noop",
    description: "does nothing",
    parameters: {
      jsonSchema: { type: "object", properties: {} },
      validate: (v) => ({ ok: true, value: (v ?? {}) as Record<string, unknown> }),
    },
  };

  async function payloadFor(
    model: Model,
    tools: Tool[],
    thinkingLevel?: string,
  ): Promise<Record<string, unknown>> {
    resetAll();
    const captured: Record<string, unknown>[] = [];
    const inner = sseFetch(OK_SSE);
    registerProvider("openai-completions", new OpenAICompatProvider());
    await complete(model, context({ messages: [new Message({ role: "user", content: "hi" })], tools }), {
      options: {
        fetch: async (url: string, init: RequestInit) => {
          captured.push(JSON.parse(String(init.body)));
          return inner(url, init);
        },
        ...(thinkingLevel === undefined ? {} : { thinking: true, thinking_level: thinkingLevel }),
      },
    });
    return captured[0]!;
  }

  test("a reasoning-capable model receives the level it was asked for", async () => {
    expect((await payloadFor(REASONER, [noopTool], "medium")).reasoning_effort).toBe("medium");
    expect((await payloadFor(REASONER, [], "high")).reasoning_effort).toBe("high");
  });

  // Verified live: gpt-5.6-* 400 on "minimal" ("Supported values are: 'none', 'low',
  // 'medium', 'high', and 'xhigh'"). xhigh IS accepted there, but the host floor stays
  // conservative until a model declares effort_levels — so it clamps rather than reaching
  // the wire, and the status bar says so.
  test("xhigh and minimal clamp instead of reaching the wire", async () => {
    expect((await payloadFor(REASONER, [], "xhigh")).reasoning_effort).toBe("high");
    expect((await payloadFor(REASONER, [], "minimal")).reasoning_effort).toBe("low");
  });

  test("Model.effort_levels widens the clamp for the model that declares it", async () => {
    const wide: Model = { ...REASONER, effort_levels: ["low", "medium", "high", "xhigh"] };
    expect((await payloadFor(wide, [], "xhigh")).reasoning_effort).toBe("xhigh");
  });

  // The fail-closed half: a level is set, and an undeclared model STILL gets a byte-identical
  // payload. gpt-4o rejects reasoning_effort at every value, "none" included (verified).
  test("a model that does not declare reasoning is untouched by a set level", async () => {
    const payload = await payloadFor(OPENAI_MODEL, [noopTool], "high");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(Object.keys(payload).sort()).toEqual([
      "max_completion_tokens",
      "messages",
      "model",
      "stream",
      "stream_options",
      "tools",
    ]);
  });

  test("thinking off sends nothing, exactly as before", async () => {
    expect(await payloadFor(REASONER, [noopTool])).not.toHaveProperty("reasoning_effort");
    expect(await payloadFor(REASONER, [noopTool], "off")).not.toHaveProperty("reasoning_effort");
  });

  // Rung 1 is inert registry data: no seed sets it. UNVERIFIED on every host — this asserts
  // the shape only, which is the one thing that does not need a key.
  test("requires_explicit_effort_off sends the host's off-payload, tools or not", async () => {
    const alwaysOff: Model = { ...REASONER, requires_explicit_effort_off: true };
    expect((await payloadFor(alwaysOff, [noopTool], "high")).reasoning_effort).toBe("none");
    expect((await payloadFor(alwaysOff, [])).reasoning_effort).toBe("none");
  });

  // The openrouter row of the quirks table, live at last (it was inert while every
  // OpenRouter-synthesized model carried zero capability flags). UNVERIFIED: no
  // OPENROUTER_API_KEY on this machine — the shape is the host's own declaration.
  test("openrouter spells both halves its own way", async () => {
    const viaOr: Model = {
      ...REASONER,
      provider: "openrouter",
      id: "openai/gpt-5.6-luna",
      base_url: "https://openrouter.ai/api/v1",
    };
    expect((await payloadFor(viaOr, [], "high")).reasoning).toEqual({ effort: "high" });
    const pinned: Model = { ...viaOr, tools_require_effort_none: true };
    expect((await payloadFor(pinned, [noopTool], "high")).reasoning).toEqual({ enabled: false });
    expect(await payloadFor(pinned, [noopTool], "high")).not.toHaveProperty("reasoning_effort");
  });
});
