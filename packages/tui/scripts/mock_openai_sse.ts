/**
 * Mock OpenAI-compatible SSE server for PTY captures and verify scenarios (MP0+).
 * Hermetic: binds 127.0.0.1 only, no outbound network, canned replies.
 *
 *   bun packages/tui/scripts/mock_openai_sse.ts &
 *   # then launch the TUI with:
 *   #   --offline --model mock-model --provider mock --provider-url http://127.0.0.1:8399/v1
 *
 * Reply selection by marker in the last user message:
 *   "SLOW" → wait MOCK_DELAY_MS (default 2500) before the first delta (echo-gap proof)
 *   "CODE" → code-heavy markdown (fenced blocks, long lines) for rendering baselines
 *   otherwise → a short text reply
 *
 * Env: MOCK_PORT (default 8399) · MOCK_DELAY_MS (default 2500)
 */

const port = Number(process.env.MOCK_PORT ?? 8399);
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 2500);

const SHORT_REPLY =
  "Baseline reply: the mock provider streamed this short answer end to end. " +
  "Nothing here is real model output — it exists so captures are deterministic.";

const SLOW_REPLY =
  "Delayed reply: this text intentionally arrived after a fixed delay so the capture " +
  "can prove the submitted prompt was echoed before any model output existed.";

const CODE_REPLY = [
  "Code-heavy baseline. First, a TypeScript block with a long line:",
  "",
  "```ts",
  "export function resolveWidget(registry: Map<string, WidgetFactory>, id: string, fallbacks: readonly string[] = DEFAULT_FALLBACK_CHAIN): Widget {",
  "  const factory = registry.get(id) ?? fallbacks.map((f) => registry.get(f)).find(Boolean);",
  "  if (!factory) throw new Error(`no widget factory for ${id}`);",
  "  return factory({ id, theme: currentTheme(), locale: navigator.language });",
  "}",
  "```",
  "",
  "Then nested Python with deep indentation:",
  "",
  "```python",
  "def walk(node, depth=0):",
  "    for child in node.children:",
  "        if child.kind == 'section':",
  "            yield from walk(child, depth + 1)",
  "        else:",
  "            yield (depth, child.title, child.span.start, child.span.end, child.checksum())",
  "```",
  "",
  "And a shell one-liner that exceeds a hundred and twenty columns to exercise wrapping behaviour in the transcript renderer:",
  "",
  "```bash",
  "rg -n 'clearTerminal|CSI 3 J' packages/tui/src/tui/app.tsx | awk -F: '{print $1\":\"$2}' | sort -t: -k2 -n | uniq -c | sort -rn | head -20",
  "```",
  "",
  "- wrapped list item: the quick brown fox jumps over the lazy dog repeatedly until the line must wrap at the current width",
  "- `inline code` mixed with **bold** and _italic_ markdown",
].join("\n");

function pickReply(prompt: string): { text: string; slow: boolean } {
  if (prompt.includes("SLOW")) return { text: SLOW_REPLY, slow: true };
  if (prompt.includes("CODE")) return { text: CODE_REPLY, slow: false };
  return { text: SHORT_REPLY, slow: false };
}

function pieces(text: string, size = 48): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path.endsWith("/health")) return new Response("ok");
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as {
      model?: string;
      messages?: { role: string; content: unknown }[];
    };
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const prompt =
      typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const { text, slow } = pickReply(prompt);
    const model = body.model ?? "mock-model";
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const chunk = (delta: object, finish: string | null = null, usage?: object) => ({
          id: "mock-1",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        });
        if (slow) await Bun.sleep(delayMs);
        send(chunk({ role: "assistant" }));
        for (const p of pieces(text)) {
          send(chunk({ content: p }));
          await Bun.sleep(25);
        }
        send(
          chunk({}, "stop", {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(text.length / 4),
            total_tokens: Math.ceil((prompt.length + text.length) / 4),
          }),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

console.log(`mock-openai-sse listening on http://127.0.0.1:${port} (delay ${delayMs}ms for SLOW)`);
