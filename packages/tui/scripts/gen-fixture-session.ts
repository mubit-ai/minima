/**
 * Generate a synthetic persisted session for TUI perf/regression testing.
 *
 * Writes a finished run with N conversation events (user/assistant/tool mix, realistic
 * markdown that wraps, CJK/emoji width edge cases, multi-line tool output) into a Minima
 * DB, named so the TUI can load it with `--resume <name>`.
 *
 *   bun run scripts/gen-fixture-session.ts --db /tmp/fixture.db --messages 500 --name fixture-500
 *
 * Point the TUI at the same file with MINIMA_DB_PATH=/tmp/fixture.db. The project key
 * defaults to repoIdentity(cwd) — generate from the same directory you resume from,
 * or pass --project explicitly.
 *
 * `--profile md|code|tool|mixed` (MP10 rendering audit) writes a small, fully scripted
 * session instead of the random mix — deterministic content packed with the rendering
 * edge cases the transcript audit shoots (fences, deep indents, overlong lines, tables,
 * blockquotes, huge tool output). `--messages` is ignored when a profile is given.
 */

import { MinimaDb } from "../src/db/minima_db.ts";
import { repoIdentity } from "../src/tui/projects.ts";

type Profile = "md" | "code" | "tool" | "mixed";

interface Args {
  db?: string;
  messages: number;
  name: string;
  project?: string;
  profile?: Profile;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { messages: 500, name: "fixture-500" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--db") out.db = take();
    else if (a === "--messages") out.messages = Number(take());
    else if (a === "--name") out.name = take();
    else if (a === "--project") out.project = take();
    else if (a === "--profile") {
      const p = take();
      if (p !== "md" && p !== "code" && p !== "tool" && p !== "mixed")
        throw new Error(`unknown profile: ${p}`);
      out.profile = p;
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isFinite(out.messages) || out.messages < 1)
    throw new Error("--messages must be >= 1");
  return out;
}

const LOREM =
  "The routing layer weighs task difficulty against the configured cost slider and picks the cheapest model whose expected quality clears the threshold; when confidence is low it escalates one tier and records why.";

/** Deterministic pseudo-random (no Math.random — reproducible fixtures). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function userText(i: number, rnd: () => number): string {
  const asks = [
    `How does the escalation ladder interact with the budget cap? (turn ${i})`,
    `Refactor the session store to batch writes — see notes ${i}`,
    `为什么第 ${i} 轮的路由决策选择了较小的模型？请解释置信度阈值。`,
    `Summarize run ${i}: what failed, what was retried, and the total cost 💸`,
    `${LOREM} And for turn ${i}: does that hold under partial failure?`,
  ];
  return asks[Math.floor(rnd() * asks.length)] ?? asks[0]!;
}

function assistantText(i: number, rnd: () => number): string {
  const parts = [
    `## Analysis for turn ${i}\n\nThe short answer is **yes** — the \`escalation\` path re-enters routing with a raised floor.\n\n- confidence below threshold → one-tier bump\n- budget cap consulted *before* the bump\n- \`decision_basis\` records the override\n\n${LOREM}`,
    `Turn ${i}: the store batches at 80ms boundaries. ${LOREM}\n\n1. open transaction\n2. drain queue\n3. fsync once\n\nEdge case: emoji-heavy content 🧠🚀 and CJK 混合宽度文本 must not split mid-grapheme.`,
    `${LOREM}\n\n${LOREM}\n\n> Note for turn ${i}: partial failure at moderate slider does **not** escalate; it books the outcome and moves on.`,
  ];
  return parts[Math.floor(rnd() * parts.length)] ?? parts[0]!;
}

function toolEvent(
  i: number,
  rnd: () => number,
): { text: string; tool_name: string; is_error: boolean } {
  const tools = ["bash", "read_file", "apply_patch", "web_search"];
  const name = tools[Math.floor(rnd() * tools.length)] ?? "bash";
  const lines = 3 + Math.floor(rnd() * 40); // some exceed the 30-row clamp on purpose
  const body = Array.from(
    { length: lines },
    (_, k) => `${name} output line ${k + 1} of turn ${i}: status=ok bytes=${1024 + k}`,
  ).join("\n");
  return { text: body, tool_name: name, is_error: rnd() < 0.05 };
}

interface FixtureEvent {
  role: "user" | "assistant" | "tool";
  text: string;
  tool_name?: string;
  is_error?: boolean;
}

const LONG_CALL =
  'const rec = await minima.recommend({ task: "summarize", prompt, slider: 0.35, pins: ["gpt-5-mini"], metadata: { retries: 3, escalate: "auto", trace_id: "b428a3c4-6ebc-4227" } });';
const LONG_TOKEN =
  "https://api.minima.sh/v1/feedback?rec=b428a3c46ebc4227&sig=aGVsbG8gd29ybGQgdGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgdG9rZW4gZm9yIHdyYXAgdGVzdGluZyBvZiBoYXJkIGJyZWFrcw";

function mdSampler(): string {
  return [
    "# Release notes — renderer audit",
    "",
    `${LOREM} ${LOREM}`,
    "",
    "## What changed",
    "",
    "- top-level item with **bold** and `inline code` plus a tail long enough to wrap at sixty columns for the narrow bookend",
    "  - nested sub-item two spaces deep",
    "    - third level, four spaces deep",
    "- *italic emphasis* and ~~strikethrough~~ pass through as-is",
    "-tight-dash line that is NOT a markdown list item",
    "",
    "### Cost table",
    "",
    "| model | cost | quality |",
    "|-------|------|---------|",
    "| haiku | $0.001 | 0.71 |",
    "| opus | $0.075 | 0.94 |",
    "",
    "> Blockquote: feedback must carry realized usage — 千里之行，始于足下 🚀🧠",
    "",
    LOREM,
  ].join("\n");
}

function codeSampler(): string {
  return [
    "TypeScript entry point first — watch the deep indent and the overlong call:",
    "",
    "```ts",
    "export async function route(task: Task): Promise<Decision> {",
    "  const features = classify(task.prompt);",
    '  if (features.type === "code_gen") {',
    `    ${LONG_CALL}`,
    "  }",
    "  return fallback(task);",
    "}",
    "```",
    "",
    "The Python mirror — comment lines start with `#`:",
    "",
    "```python",
    "# derive the cost basis before scoring",
    "def score(candidates, basis):",
    "        weights = rescale(basis)  # deliberate 8-space indent",
    "        return sorted(candidates, key=lambda c: c.cost * weights[c.tier])",
    "",
    "def apply(**kwargs):",
    "    # '#' lines and '**kwargs' both confuse the renderer today",
    "    return kwargs",
    "```",
    "",
    "Config as YAML — dash lines inside code:",
    "",
    "```yaml",
    "- name: recommend",
    "  cost_basis: observed",
    "# a comment between items",
    "- name: feedback",
    "  required: [input_tokens, output_tokens, actual_cost_usd]",
    "```",
    "",
    "And the stream cut out mid-block here (fence never closes):",
    "",
    "```bash",
    `curl -s ${LONG_TOKEN} | jq .outcome`,
    "echo done",
  ].join("\n");
}

function bigToolOutput(lines: number): string {
  return Array.from({ length: lines }, (_, k) => {
    if (k % 40 === 17)
      return `line ${k + 1}: WIDE ${"status=ok bytes=4096 cache=hit tier=observed basis=rescaled ".repeat(4)}end`;
    return `line ${k + 1}: check=${k % 7 === 0 ? "retry" : "pass"} elapsed_ms=${12 + k}`;
  }).join("\n");
}

function profileScript(profile: Profile): FixtureEvent[] {
  const md: FixtureEvent[] = [
    { role: "user", text: "Draft the release notes for the renderer audit (md profile)." },
    { role: "assistant", text: mdSampler() },
  ];
  const code: FixtureEvent[] = [
    { role: "user", text: "Show me the routing implementation across languages (code profile)." },
    { role: "assistant", text: codeSampler() },
  ];
  const tool: FixtureEvent[] = [
    { role: "user", text: "Run the full verification sweep and show the log (tool profile)." },
    { role: "tool", text: bigToolOutput(244), tool_name: "bash" },
    { role: "tool", text: "rg: pattern not found in 3 of 41 files", tool_name: "grep", is_error: true },
    { role: "assistant", text: "The sweep passed — 244 log lines captured above, one benign grep miss." },
  ];
  switch (profile) {
    case "md":
      return md;
    case "code":
      return code;
    case "tool":
      return tool;
    case "mixed":
      return [
        ...md,
        { role: "user", text: "Now the code side, please." },
        { role: "tool", text: bigToolOutput(64), tool_name: "read_file" },
        ...code.slice(1),
      ];
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = args.db ? new MinimaDb(args.db) : new MinimaDb();
  const projectKey = args.project ?? repoIdentity(process.cwd());
  db.ensureProject(projectKey, null);

  const runId = db.startRun({ projectKey });

  if (args.profile) {
    const script = profileScript(args.profile);
    const pbase = Date.now() / 1000 - script.length * 2;
    db.transact(() => {
      script.forEach((ev, k) => {
        const ts = pbase + k * 2;
        if (ev.role === "tool") {
          db.appendEvent({
            runId,
            type: "tool",
            ts,
            payload: { text: ev.text, tool_name: ev.tool_name ?? "bash", is_error: ev.is_error === true },
          });
        } else if (ev.role === "assistant") {
          db.appendEvent({
            runId,
            type: "assistant",
            ts,
            payload: {
              text: ev.text,
              model: "fixture-model",
              stop_reason: "stop",
              usage: { input: 1200, output: 400, cache_read: 0, cache_write: 0, cost_total: 0.002 },
            },
          });
        } else {
          db.appendEvent({ runId, type: "user", ts, payload: { text: ev.text } });
        }
      });
    });
    db.finishRun(runId, "done");
    db.setRunName(runId, args.name);
    const count = db.countEvents(runId);
    db.close();
    console.log(
      JSON.stringify({
        run_id: runId,
        name: args.name,
        project_key: projectKey,
        profile: args.profile,
        events: count,
        db: args.db ?? "(default)",
      }),
    );
    return;
  }

  const rnd = mulberry32(500);
  const base = Date.now() / 1000 - args.messages * 2;

  let written = 0;
  db.transact(() => {
    for (let i = 0; written < args.messages; i++) {
      const ts = base + written * 2;
      // Pattern: user, assistant, sometimes tool+assistant — mirrors real transcripts.
      db.appendEvent({ runId, type: "user", ts, payload: { text: userText(i, rnd) } });
      written++;
      if (written >= args.messages) break;
      if (rnd() < 0.4) {
        const t = toolEvent(i, rnd);
        db.appendEvent({ runId, type: "tool", ts: ts + 0.5, payload: t });
        written++;
        if (written >= args.messages) break;
      }
      db.appendEvent({
        runId,
        type: "assistant",
        ts: ts + 1,
        payload: {
          text: assistantText(i, rnd),
          model: "fixture-model",
          stop_reason: "stop",
          usage: {
            input: 1200 + i,
            output: 400 + i,
            cache_read: 0,
            cache_write: 0,
            cost_total: 0.001 * i,
          },
        },
      });
      written++;
    }
  });

  db.finishRun(runId, "done");
  db.setRunName(runId, args.name);
  const count = db.countEvents(runId);
  db.close();
  console.log(
    JSON.stringify({
      run_id: runId,
      name: args.name,
      project_key: projectKey,
      events: count,
      db: args.db ?? "(default)",
    }),
  );
}

main();
