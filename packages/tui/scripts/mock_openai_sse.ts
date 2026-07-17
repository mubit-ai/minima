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
 *   "TODO" → a todowrite tool_calls stream (3 canned tasks, one in_progress) — TWO-PHASE:
 *            once THIS TURN carries a tool result (a role "tool" message after the last
 *            user message), the follow-up request gets a plain text reply instead, so the
 *            agent loop terminates; a NEW user turn re-arms the marker
 *   "TODOV"/"TODOVSWAP"/"TODOVDONE" → MP18 consent drivers: one task with a verify shell
 *            command / the same task with a MUTATED verify / a completed claim (done-gate)
 *   otherwise → a short text reply
 *
 * Council answering (MP14+): plan-mode meta calls carry a role-distinct SYSTEM prompt
 * (plan_council.ts — scopeSystem / KEEPER_CHECK_SYSTEM / DRAFT_SYSTEM / REVISE_SYSTEM /
 * CRITIC_SYSTEM / SYNTH_SYSTEM / RESOLVE_SYSTEM / GROUND_TRUTH_SYSTEM). Requests whose
 * system message matches a role phrase get that role's canned reply, each delayed
 * MOCK_COUNCIL_STAGE_MS so the busy-row progress line visibly dwells per phase. The
 * researcher sub-agent's request has no council system prompt, so it falls through to the
 * default short reply. Markers key on role-name phrases (the stable identity of each stage);
 * if a council prompt is reworded, update the matching substring here.
 *
 * Env: MOCK_PORT (default 8399) · MOCK_DELAY_MS (default 2500) ·
 *      MOCK_COUNCIL_STAGE_MS (default 400)
 */

const port = Number(process.env.MOCK_PORT ?? 8399);
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 2500);
const councilStageMs = Number(process.env.MOCK_COUNCIL_STAGE_MS ?? 400);

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

const COUNCIL_DRAFT = [
  "## Demo widget plan (draft)",
  "",
  "1. Scaffold `demo_widget.ts` with the render entry point.",
  "2. Wire the widget into the footer registry.",
  "3. Add a regression test that pins the rendered rows.",
  "",
  "Grounded in the researcher notes; the registry already exposes a factory seam.",
].join("\n");

const COUNCIL_SYNTH = JSON.stringify({
  title: "Demo Widget Wiring",
  goal: "Ship the demo widget through the existing footer registry seam.",
  plan: COUNCIL_DRAFT,
  decisions: [
    {
      topic: "registry seam",
      decision: "reuse the existing factory registry",
      rationale: "no new plumbing",
    },
  ],
  findings: [
    { source: "researcher", summary: "footer registry exposes a factory seam", severity: "info" },
    {
      source: "critic",
      summary: "rendered-row pin must cover the 60-col floor",
      severity: "concern",
    },
  ],
  questions: [],
  facts: ["the footer registry lives in the TUI layer"],
  constraints: ["no new dependencies"],
});

const COUNCIL_GT = JSON.stringify({
  title: "Demo Widget Wiring",
  goal: "Ship the demo widget through the existing footer registry seam.",
  overview: "Scaffold the widget, register it, and pin its rendering with a regression test.",
  requirements: ["widget renders through the registry", "rows pinned by test"],
  constraints: ["no new dependencies"],
  decisions: [
    {
      topic: "registry seam",
      decision: "reuse the existing factory registry",
      rationale: "no new plumbing",
    },
  ],
  approach: [
    {
      action: "Scaffold demo_widget.ts with the render entry point",
      verify: "test -f demo_widget.ts",
      tools: ["write"],
    },
    {
      action: "Pin the rendered rows with a regression test",
      verify: "bun test demo_widget.test.ts",
      tools: ["write", "bash"],
    },
  ],
  risks: ["registry ordering is load-bearing"],
  successCriteria: ["bun test green"],
  openItems: [],
});

// Reply per council role, keyed on the request's SYSTEM prompt (see header). Null = not a
// council call. Critic/keeper return [] (clean pass) so the round stays single-pass and no
// question overlay blocks a scripted PTY run (synth surfaces zero questions).
function councilReply(system: string): string | null {
  if (system.includes("break the RESEARCH needed")) {
    return JSON.stringify([
      {
        focus: "Inspect the demo surface",
        boundaries: "nothing beyond the demo area",
        output_format: "terse notes",
        difficulty: "easy",
      },
    ]);
  }
  if (system.includes("reviewing researcher findings")) return "[]";
  if (system.includes("keeping the working draft current")) {
    return JSON.stringify({
      plan: "## Demo widget plan (draft)\n\nKeeper-refreshed after the follow-up exchange.",
      decisions: [],
      questions: [],
    });
  }
  if (system.includes("SYNTHESIST of a planning council. Using the research")) return COUNCIL_DRAFT;
  if (system.includes("SYNTHESIST of a planning council revising")) return COUNCIL_DRAFT;
  if (system.includes("adversarial CRITIC")) return "[]";
  if (system.includes("RECORDER of a planning council. Turn the plan")) return COUNCIL_SYNTH;
  if (system.includes("RECORDER of a planning council finalizing")) return "[]";
  if (system.includes("RECORDER of a planning council writing the FINAL")) return COUNCIL_GT;
  return null;
}

const TODO_TASKS = JSON.stringify([
  { content: "scaffold the parser", status: "completed", priority: "high" },
  { content: "wire the panel data", status: "in_progress", priority: "high" },
  { content: "write regression tests", status: "pending", priority: "medium" },
]);
const TODO_DONE_REPLY =
  "Todo list recorded — the canned plan is underway. This second-phase reply exists so " +
  "the tool loop terminates deterministically.";

// MP18: "TODOV" → a ONE-task todowrite carrying a `verify` shell command (drives the
// consent overlay); "TODOVSWAP" mutates the verify (must re-prompt); "TODOVDONE" claims
// completion with a verify (drives the done-gate — headless consent proof). All two-phase.
// Substring precedence: TODOVDONE/TODOVSWAP before TODOV before TODO.
function todoVTasks(prompt: string): string {
  const task = prompt.includes("TODOVDONE")
    ? { content: "Record the demo step", status: "completed", verify: "true" }
    : prompt.includes("TODOVSWAP")
      ? { content: "Record the demo step", status: "in_progress", verify: "echo consent-swapped" }
      : { content: "Record the demo step", status: "in_progress", verify: "echo consent-ok" };
  return JSON.stringify([task]);
}

// MP17: "EXITPLAN" → an exit_plan tool call carrying the canned plan markdown (the CC-style
// GT-off contract), TWO-PHASE like TODO so the loop terminates after the tool result.
const EXITPLAN_MD = [
  "## Sandbox cleanup plan",
  "",
  "1. Inventory the sandbox temp dirs.",
  "2. Delete the stale ones and verify the count drops.",
  "3. Note the retention rule in the runbook.",
].join("\n");
const EXITPLAN_DONE_REPLY =
  "Acknowledged — proceeding per the approval outcome. This second-phase reply exists so " +
  "the tool loop terminates deterministically.";

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
      typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? "");
    const sysMsg = (body.messages ?? []).find((m) => m.role === "system");
    const sys = typeof sysMsg?.content === "string" ? sysMsg.content : "";
    const council = councilReply(sys);
    // Two-phase detection is TURN-scoped: a tool result AFTER the last user message means
    // this request is the same turn's follow-up (phase 2 → plain text so the loop ends).
    // Keying on any-tool-result-in-history froze every marker after the first tool turn.
    const msgs = body.messages ?? [];
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
    const hasToolResult = msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
    const wantTodoV = council == null && prompt.includes("TODOV") && !hasToolResult;
    const wantTodo =
      council == null && prompt.includes("TODO") && !prompt.includes("TODOV") && !hasToolResult;
    const wantExitPlan = council == null && prompt.includes("EXITPLAN") && !hasToolResult;
    const toolCall = wantTodoV
      ? { name: "todowrite", args: JSON.stringify({ tasks: todoVTasks(prompt) }) }
      : wantTodo
        ? { name: "todowrite", args: JSON.stringify({ tasks: TODO_TASKS }) }
        : wantExitPlan
          ? {
              name: "exit_plan",
              args: JSON.stringify({
                plan: EXITPLAN_MD,
                summary: "Clean up the sandbox temp dirs",
              }),
            }
          : null;
    const { text, slow } =
      council != null
        ? { text: council, slow: false }
        : prompt.includes("TODO")
          ? { text: TODO_DONE_REPLY, slow: false }
          : prompt.includes("EXITPLAN")
            ? { text: EXITPLAN_DONE_REPLY, slow: false }
            : pickReply(prompt);
    const model = body.model ?? "mock-model";
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const chunk = (delta: object, finish: string | null = null, usage?: object) => ({
          id: "mock-1",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        });
        if (toolCall) {
          send(chunk({ role: "assistant" }));
          send(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_${toolCall.name}_1`,
                  type: "function",
                  function: { name: toolCall.name, arguments: "" },
                },
              ],
            }),
          );
          const args = toolCall.args;
          for (const p of pieces(args)) {
            send(chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] }));
            await Bun.sleep(15);
          }
          send(
            chunk({}, "tool_calls", {
              prompt_tokens: Math.ceil(prompt.length / 4),
              completion_tokens: Math.ceil(args.length / 4),
              total_tokens: Math.ceil((prompt.length + args.length) / 4),
            }),
          );
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        if (slow) await Bun.sleep(delayMs);
        if (council != null) await Bun.sleep(councilStageMs);
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
