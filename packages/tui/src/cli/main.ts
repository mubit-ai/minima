/**
 * `minima` CLI entry point — port of the Python harness's tui/cli.py.
 *
 * Parses args, loads .env, builds the HarnessConfig + toolset + MinimaAgent, and
 * dispatches to one of: --print (one-shot), --mode json (event stream), or the
 * interactive Ink TUI (default). The Python recommender service stays in Python;
 * this binary only needs a MUBIT_API_KEY (routing) + a provider key (calling).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { render } from "ink";
import React from "react";
import { setMode } from "../agent/modes.ts";
import type { BeforeToolCall } from "../agent/tools.ts";
import { CHEAP_FALLBACK_MODELS, resolveRunnableModel } from "../ai/model_fallback.ts";
import { providerKeyPresent } from "../ai/provider_catalog.ts";
import { ensureProvidersRegistered } from "../ai/providers/index.ts";
import { findModelById, registerModel } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import { MinimaDb, type RunRow, defaultDbPath, toolSchemaHash } from "../db/minima_db.ts";
import { type RehydratedRun, applyRehydratedRun, rehydrateRun } from "../db/rehydrate.ts";
import { type DbSinkHandle, attachDbSink } from "../db/sink.ts";
import { errText } from "../errtext.ts";
import { makeBashSteerHook } from "../minima/bash_steer.ts";
import { type VerifyConsent, bigPlanHooks, headlessVerifyConsent } from "../minima/big_plan.ts";
import { BudgetLedger } from "../minima/budget.ts";
import { collectRunDiff, runDiffReview } from "../minima/diff_review.ts";
import {
  CostMeter,
  type HarnessConfig,
  MinimaAgent,
  configFromEnv,
  createPreferenceProbe,
  resolvePlanModels,
} from "../minima/index.ts";
import { ConstJudge, LLMJudge, TaskClassifier } from "../minima/index.ts";
import { drainMemoryJobs, makeRoutedExtractor } from "../minima/memory_scribe.ts";
import { createMubitMemory } from "../minima/mubit_memory_factory.ts";
import { type ObserverHandle, maybeAttachObserver } from "../minima/observer.ts";
import { type ChildEvent, createSpawn } from "../minima/spawn.ts";
import { runJson, runPrint } from "../run_modes.ts";
import { detectRepo, makeCheckpointHook } from "../session/checkpoint.ts";
import { reverifyNotice, reverifyOnResume } from "../session/resume_verify.ts";
import { makeArtifactReadTouchHook } from "../tools/_artifact_gc.ts";
import { ArtifactStore } from "../tools/_artifacts.ts";
import { BgJobRegistry } from "../tools/_bgjobs.ts";
import { LspManager, makeLspDiagnosticsHook } from "../tools/_lsp.ts";
import { SeenLedger } from "../tools/_seen.ts";
import { registerContextRewindTools } from "../tools/checkpoint_rewind.ts";
import { type AskUserRef, builtinTools, questionTool } from "../tools/index.ts";
import { taskTool } from "../tools/task.ts";
import type { TodoTask } from "../tools/todowrite.ts";
import type { ToolArtifacts } from "../tools/types.ts";
import { HarnessApp } from "../tui/app.tsx";
import { DEFAULT_CONSOLE_URL, ProvisioningPending, runAuth } from "../tui/auth.ts";
import {
  SECTIONS,
  hydrateEnv,
  mask,
  get as storeGet,
  setValue as storeSetValue,
} from "../tui/config_store.ts";
import { buildSystemPrompt } from "../tui/context.ts";
import { installInputFilter } from "../tui/input-filter.ts";
import { loadPersistedMode } from "../tui/mode_prefs.ts";
import { getProject, repoIdentity, setProject } from "../tui/projects.ts";
import { VERSION } from "../version.ts";

// --- MINIMA_TUI_DEBUG_ANCHOR diagnostics ---------------------------------------------
// The anchor probe (reserve line here + per-render ledger line in app.tsx) proved the
// ledger held bottom-invariance while the user's real terminal still showed a top-seated
// frame — so the remaining questions are byte-level: did the reserve reach the terminal
// before frame 1, did any writer emit a clear/home, and where did the cursor actually
// end up. These two taps answer all three; both are inert unless the env var is set.

function installAnchorWriteTap(file: string): void {
  const streams: Array<["out" | "err", NodeJS.WriteStream]> = [
    ["out", process.stdout],
    ["err", process.stderr],
  ];
  for (const [fd, stream] of streams) {
    const orig = stream.write.bind(stream);
    (stream as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
      try {
        const chunk = args[0];
        const s =
          typeof chunk === "string"
            ? chunk
            : Buffer.isBuffer(chunk)
              ? chunk.toString("latin1")
              : String(chunk);
        const vis = s.replaceAll("\u001b", "^[");
        const flags: string[] = [];
        if (vis.includes("^[[2J")) flags.push("2J");
        if (vis.includes("^[[3J")) flags.push("3J");
        if (vis.includes("^[[H") || vis.includes("^[[1;1H")) flags.push("H");
        if (/\^\[\[\d+;\d+H/.test(vis)) flags.push("CUP");
        if (/\^\[\[\d*A/.test(vis)) flags.push("UP");
        if (/\^\[\[[02]?K/.test(vis)) flags.push("EL");
        if (vis.includes("^[[6n")) flags.push("6n");
        if (vis.includes("^[[?25l")) flags.push("25l");
        if (vis.includes("^[[?104".concat("9"))) flags.push("1049");
        const nl = (s.match(/\n/g) ?? []).length;
        const head = vis.slice(0, 64).replaceAll("\n", "\\n");
        appendFileSync(
          file,
          `${JSON.stringify({ t: Date.now(), tap: fd, len: s.length, nl, flags, head })}\n`,
        );
        if (fd === "out" && (typeof chunk === "string" || Buffer.isBuffer(chunk))) {
          appendFileSync(`${file}.raw`, chunk);
        }
      } catch {}
      return (orig as (...a: unknown[]) => boolean)(...args);
    };
  }
}

// One-shot DSR (ESC[6n): asks the terminal where the cursor REALLY is right after the
// newline reserve — the reply lands on stdin as ESC[row;colR. Debug-only: adds up to
// 250ms before first render; a reply arriving after the timeout would leak ~6 junk
// chars into Ink's key parser, acceptable for a diagnostic run.
async function probeCursorRow(file: string): Promise<void> {
  const stdin = process.stdin;
  if (process.stdout.isTTY !== true || stdin.isTTY !== true) return;
  const wasRaw = (stdin as { isRaw?: boolean }).isRaw === true;
  await new Promise<void>((resolveProbe) => {
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (row: number | null, col: number | null) => {
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      stdin.pause();
      try {
        if (!wasRaw) stdin.setRawMode(false);
      } catch {}
      try {
        const raw = row === null ? buf.replaceAll("\u001b", "^[") : undefined;
        appendFileSync(file, `${JSON.stringify({ t: Date.now(), phase: "dsr", row, col, raw })}\n`);
      } catch {}
      resolveProbe();
    };
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const m = buf.match(/\[(\d+);(\d+)R/);
      if (m) done(Number(m[1]), Number(m[2]));
    };
    timer = setTimeout(() => done(null, null), 250);
    try {
      stdin.setRawMode(true);
    } catch {}
    stdin.on("data", onData);
    stdin.resume();
    process.stdout.write("\u001b[6n");
  });
}

// --- .env loading (cwd) — real env / --env-file wins; file only fills gaps ----------
const ENV_FILES = [".env.harness", ".env"];

async function loadEnvFiles(): Promise<void> {
  for (const name of ENV_FILES) {
    const path = resolve(name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const val = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
  // Per-user store (OS keychain + ~/.minima-harness/config.env) — lowest precedence, so
  // shell env and project .env files still win. Failures never block startup.
  try {
    await hydrateEnv();
  } catch {
    // config must never block startup
  }
}

// --- a lean default model catalog --------------------------------------------------
export const SEED_MODELS: Model[] = [
  {
    id: "gpt-4o-mini",
    provider: "openai",
    api: "openai-completions",
    name: "GPT-4o mini",
    cost: { input: 0.15, output: 0.6 },
    context_window: 128_000,
    max_tokens: 16_384,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    api: "openai-completions",
    name: "GPT-4o",
    cost: { input: 2.5, output: 10 },
    context_window: 128_000,
    max_tokens: 16_384,
  },
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    api: "openai-completions",
    name: "GPT-5.6 Sol",
    cost: { input: 5.0, output: 30.0, cache_read: 0.5 },
    context_window: 1_050_000,
    max_tokens: 128_000,
    reasoning: true,
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    api: "openai-completions",
    name: "GPT-5.6 Terra",
    cost: { input: 2.5, output: 15.0, cache_read: 0.25 },
    context_window: 1_050_000,
    max_tokens: 128_000,
    reasoning: true,
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    api: "openai-completions",
    name: "GPT-5.6 Luna",
    cost: { input: 1.0, output: 6.0, cache_read: 0.1 },
    context_window: 1_050_000,
    max_tokens: 128_000,
    reasoning: true,
  },
  {
    // deepseek-chat (V3) is deprecated by DeepSeek effective 2026-07-24; V4 Flash replaces it.
    id: "deepseek-v4-flash",
    provider: "deepseek",
    api: "openai-completions",
    name: "DeepSeek V4 Flash",
    cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
    context_window: 1_000_000,
    max_tokens: 384_000,
    base_url: "https://api.deepseek.com",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    name: "DeepSeek V4 Pro",
    cost: { input: 0.435, output: 0.87 },
    context_window: 1_000_000,
    max_tokens: 384_000,
    reasoning: true,
    base_url: "https://api.deepseek.com",
  },
  {
    id: "grok-4.5",
    provider: "xai",
    api: "openai-completions",
    name: "Grok 4.5",
    cost: { input: 2.0, output: 6.0, cache_read: 0.5 },
    context_window: 500_000,
    max_tokens: 16_384,
    reasoning: true,
    base_url: "https://api.x.ai/v1",
  },
  {
    id: "grok-4.3",
    provider: "xai",
    api: "openai-completions",
    name: "Grok 4.3",
    cost: { input: 1.25, output: 2.5 },
    context_window: 1_000_000,
    max_tokens: 16_384,
    reasoning: true,
    base_url: "https://api.x.ai/v1",
  },
  {
    id: "z-ai/glm-5.2",
    provider: "openrouter",
    api: "openai-completions",
    name: "GLM 5.2",
    cost: { input: 0.82, output: 2.58 },
    context_window: 1_000_000,
    max_tokens: 16_384,
    base_url: "https://openrouter.ai/api/v1",
  },
  {
    id: "moonshotai/kimi-k2.6",
    provider: "openrouter",
    api: "openai-completions",
    name: "Kimi K2.6",
    cost: { input: 0.66, output: 3.41 },
    context_window: 262_144,
    max_tokens: 16_384,
    base_url: "https://openrouter.ai/api/v1",
  },
  {
    id: "minimax/minimax-m3",
    provider: "openrouter",
    api: "openai-completions",
    name: "MiniMax M3",
    cost: { input: 0.098, output: 1.21 },
    context_window: 1_000_000,
    max_tokens: 16_384,
    base_url: "https://openrouter.ai/api/v1",
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    api: "anthropic-messages",
    name: "Claude Haiku 4.5",
    cost: { input: 1.0, output: 5.0, cache_read: 0.08, cache_write: 1.25 },
    context_window: 200_000,
    max_tokens: 8192,
    reasoning: false,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    name: "Claude Sonnet 4.6",
    cost: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    context_window: 200_000,
    max_tokens: 16384,
    reasoning: true,
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    api: "anthropic-messages",
    name: "Claude Opus 4.8",
    cost: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    context_window: 200_000,
    max_tokens: 16384,
    reasoning: true,
    adaptive_thinking: true,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    api: "anthropic-messages",
    name: "Claude Sonnet 5",
    cost: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    context_window: 1_000_000,
    max_tokens: 128_000,
    reasoning: true,
    adaptive_thinking: true,
  },
  {
    id: "claude-fable-5",
    provider: "anthropic",
    api: "anthropic-messages",
    name: "Claude Fable 5",
    cost: { input: 10.0, output: 50.0, cache_read: 1.0, cache_write: 12.5 },
    context_window: 1_000_000,
    max_tokens: 128_000,
    reasoning: true,
    adaptive_thinking: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    api: "google-generative-ai",
    name: "Gemini 2.5 Flash",
    cost: { input: 0.3, output: 2.5 },
    context_window: 1_000_000,
    max_tokens: 8192,
    reasoning: true,
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    api: "google-generative-ai",
    name: "Gemini 2.5 Pro",
    cost: { input: 1.25, output: 10.0 },
    context_window: 2_000_000,
    max_tokens: 8192,
    reasoning: true,
  },
  {
    id: "gemini-3.6-flash",
    provider: "google",
    api: "google-generative-ai",
    name: "Gemini 3.6 Flash",
    cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
    context_window: 1_048_576,
    max_tokens: 65_536,
    reasoning: true,
  },
];

function seedDefaultModels(): void {
  ensureProvidersRegistered();
  for (const m of SEED_MODELS) registerModel(m);
}

// --- arg parsing --------------------------------------------------------------------
export interface CliArgs {
  prompt: string[];
  model?: string;
  provider?: string;
  /** OpenAI-compatible base URL for a custom --provider (ollama/vLLM/llama.cpp/mock). */
  providerUrl?: string;
  thinking: string;
  offline: boolean;
  print: boolean;
  mode: "interactive" | "print" | "json";
  tools?: string;
  excludeTools?: string;
  noTools: boolean;
  /** Session budget in USD (creates a BudgetLedger; warn mode unless --budget-enforce). */
  budgetUsd?: number;
  budgetEnforce: boolean;
  /** cost/quality slider 0..10 (0 = cheapest acceptable, 10 = highest quality). */
  slider?: number;
  /** Resume a previous session by display name or run-id (prefix ≥ 4 chars). */
  resume?: string;
  /** Start in bypass mode: every tool call pre-approved (also adds bypass to the Shift+Tab ring). */
  bypassPermissions?: boolean;
  /** Turn on the experimental umbrella (same as MINIMA_TUI_EXPERIMENTAL=1). */
  experimental?: boolean;
}

/** What -v/--version prints (single line, stdout — scripts parse this). */
export const VERSION_LINE = `minima ${VERSION}`;

export function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {
    prompt: [],
    thinking: "off",
    offline: false,
    print: false,
    mode: "interactive",
    noTools: false,
    budgetEnforce: false,
  };
  const take = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`flag ${argv[i]} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-p":
      case "--print":
        opts.print = true;
        break;
      case "--mode":
        opts.mode = take(i++) as CliArgs["mode"];
        break;
      case "--model":
        opts.model = take(i++);
        break;
      case "--provider":
        opts.provider = take(i++);
        break;
      case "--provider-url":
        opts.providerUrl = take(i++);
        break;
      case "--thinking":
        opts.thinking = take(i++);
        break;
      case "--offline":
        opts.offline = true;
        break;
      case "--dangerously-bypass-permissions":
        opts.bypassPermissions = true;
        break;
      case "--experimental":
        opts.experimental = true;
        break;
      case "-t":
      case "--tools":
        opts.tools = take(i++);
        break;
      case "-xt":
      case "--exclude-tools":
        opts.excludeTools = take(i++);
        break;
      case "-nt":
      case "--no-tools":
        opts.noTools = true;
        break;
      case "-b":
      case "--budget": {
        const v = Number(take(i++));
        if (!Number.isFinite(v) || v <= 0)
          throw new Error("--budget requires a positive USD amount");
        opts.budgetUsd = v;
        break;
      }
      case "--budget-enforce":
        opts.budgetEnforce = true;
        break;
      case "--resume":
        opts.resume = take(i++);
        break;
      case "--slider": {
        const v = Number(take(i++));
        if (!Number.isFinite(v) || v < 0 || v > 10)
          throw new Error("--slider requires a number between 0 and 10");
        opts.slider = v;
        break;
      }
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "-v":
      case "--version":
        process.stdout.write(`${VERSION_LINE}\n`);
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
        opts.prompt.push(a);
    }
  }
  return opts;
}

const HELP = `minima — cost-aware model-routing coding agent.

Usage: minima [prompt] [--print|--mode json] [options]
       minima auth              sign in to Mubit + provision this repo's project
       minima config [set|get]  manage stored credentials

  -p, --print              one-shot: print the reply and exit
      --mode {interactive|print|json}
      --model ID           pin a model (bypasses routing)
      --provider NAME      provider for a pinned --model
      --provider-url URL   OpenAI-compatible base URL for a custom --provider (ollama/vLLM)
      --thinking LEVEL     off|minimal|low|medium|high|xhigh
      --offline            bypass Minima routing
      --dangerously-bypass-permissions
                           start in bypass mode: every tool call runs without prompting
      --experimental       turn on experimental features (same as MINIMA_TUI_EXPERIMENTAL=1)
  -t, --tools LIST         comma-separated tool allowlist
  -xt, --exclude-tools LIST
  -nt, --no-tools
      --resume NAME|ID     resume a previous session by name or run-id prefix (see /name, /rename)
  -b, --budget USD         session budget (graduated warnings at 50/75/90/100%)
      --budget-enforce     refuse runs once the budget is exhausted (default: warn)
      --slider N           cost/quality 0..10 (0 = cheapest acceptable; default 5)
  -v, --version            print the version and exit
  -h, --help

  Plan verification headless note (MINIMA_TUI_BIG_PLAN=1 + -p/--mode json): plan-step
  \`verify\` shell commands fail CLOSED without an interactive user to approve them —
  set MINIMA_TUI_ALLOW_VERIFY=1 to opt a headless run into executing them.
`;

function toolsFor(
  args: CliArgs,
  bigPlan: boolean,
  todoState?: TodoTask[],
  onWebSearchFeeUsd?: (usd: number, toolCallId: string) => void,
  artifacts?: ToolArtifacts,
  seen?: SeenLedger,
  bgJobs?: BgJobRegistry,
) {
  let tools = args.noTools
    ? []
    : builtinTools({ bigPlan, todoState, onWebSearchFeeUsd, artifacts, seen, bgJobs });
  if (args.tools) {
    const allow = new Set(args.tools.split(",").map((s) => s.trim()));
    tools = tools.filter((t) => allow.has(t.name));
  }
  if (args.excludeTools) {
    const deny = new Set(args.excludeTools.split(",").map((s) => s.trim()));
    tools = tools.filter((t) => !deny.has(t.name));
  }
  return tools;
}

export function buildConfig(args: CliArgs): HarnessConfig {
  // The flag IS the env var: setting it here (before any configFromEnv) reaches every
  // later resolution site and inherits to spawned sub-agents. An explicit env "0" on a
  // per-feature flag still wins inside optInFlag.
  if (args.experimental) process.env.MINIMA_TUI_EXPERIMENTAL = "1";
  const cfg = configFromEnv();
  if (args.offline) cfg.minimaUrl = "";
  if (args.model) {
    cfg.candidates = [args.model];
    cfg.pinned = true;
  }
  if (args.slider !== undefined) cfg.costQualityTradeoff = args.slider;
  return cfg;
}

/**
 * Judge wiring, extracted for tests: sampled LLM grading is ON by default whenever a
 * runnable judge model exists. The configured model (MINIMA_JUDGE_MODEL) wins when its
 * provider key is present; otherwise the cheap-model ladder substitutes the first
 * runnable fallback (one-time notice names the substitution) — without this, a user
 * with only e.g. a Gemini key silently never gets a graded turn. No runnable model at
 * all keeps ConstJudge(null) (abstain). MINIMA_LLM_JUDGE=0 disables entirely.
 */
export function buildJudge(
  config: HarnessConfig,
  onCostUsd: (usd: number) => void,
): { judge: ConstJudge | LLMJudge; notices: string[] } {
  const judgeMode = process.env.MINIMA_LLM_JUDGE;
  if (judgeMode === "0" || config.judgeSampleRate <= 0) {
    return { judge: new ConstJudge(null), notices: [] };
  }
  const resolved = resolveRunnableModel(config.judgeModel);
  if (!resolved) {
    return {
      judge: new ConstJudge(null),
      notices:
        judgeMode === "1"
          ? [
              `MINIMA_LLM_JUDGE=1 ignored (judge model ${config.judgeModel} unavailable or key missing)`,
            ]
          : [],
    };
  }
  const notices: string[] = [];
  if (resolved.substituted) {
    notices.push(
      `judge model ${config.judgeModel} has no provider key — using ${resolved.model.id} instead`,
    );
  }
  const coverage =
    config.judgeSampleRate >= 1
      ? "every ungated turn"
      : `~${Math.round(config.judgeSampleRate * 100)}% of ungated turns`;
  notices.push(
    `sampled LLM judge on (${resolved.model.id}, ${coverage}; MINIMA_LLM_JUDGE=0 disables) — spend books to /cost + budget`,
  );
  return { judge: new LLMJudge(resolved.model, { onCostUsd }), notices };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  await loadEnvFiles();

  // `minima config …` — credential setup (no TUI; works before any keys exist).
  if (argv[0] === "config") return configCli(argv.slice(1));

  // `minima auth` — one-click browser login + per-repo project provisioning.
  if (argv[0] === "auth") return authCli(argv.slice(1));

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`minima: ${errText(exc)}\n`);
    return 2;
  }

  seedDefaultModels();
  if (args.model && !findModelByIdLocal(args.model) && args.provider) {
    registerModel({
      id: args.model,
      provider: args.provider,
      api: "openai-completions",
      name: args.model,
      cost: { input: 0, output: 0 },
      context_window: 128_000,
      max_tokens: 8_192,
      base_url: args.providerUrl,
    });
  }

  const config = buildConfig(args);
  // Per-repo memory isolation: MINIMA_NAMESPACE env wins, else the project
  // provisioned for this repo by `minima auth` (~/.minima-harness/projects.json).
  const nsEnv = process.env.MINIMA_NAMESPACE?.trim();
  if (nsEnv) {
    config.namespace = nsEnv;
  } else {
    const mapping = await getProject(repoIdentity(process.cwd()));
    if (mapping?.namespace) config.namespace = mapping.namespace;
  }
  const todoState: TodoTask[] = [];
  // Artifact spill store (P1): one instance shared by the lead's tools and every spawned
  // child; attach() late-binds the DB index once the run row exists (bookSearchFee pattern).
  const dbPath = defaultDbPath();
  const artifactStore =
    config.artifacts && dbPath !== ":memory:"
      ? new ArtifactStore({
          dir: join(dirname(dbPath), "artifacts"),
          gcBudgetBytes: Math.floor(config.artifactGcMb * 1024 * 1024),
        })
      : null;
  // Background bash jobs (W4.1): in-memory Subprocess handles + a durable bg_jobs row.
  // attach() late-binds the DB + run below (artifactStore pattern) and runs the reaper;
  // shutdown() at closeDb kills live jobs at session end (orphan policy).
  const bgJobRegistry = config.bgJobs ? new BgJobRegistry() : null;
  // LSP diagnostics (W5.1, opt-in): a hand-rolled stdio JSON-RPC client that surfaces a
  // locally-installed language server's diagnostics ADDITIVELY in edit/write/apply_patch
  // results via one afterToolCall hook; killed at session end (closeDb). Flag-off →
  // null → hook never registered → results byte-identical. Lead agent uses ambient cwd.
  const lspManager = config.lsp
    ? new LspManager({
        workdir: process.cwd(),
        ...(config.lspTimeoutMs > 0 ? { timeoutMs: config.lspTimeoutMs } : {}),
      })
    : null;
  // web_search provider fees (MUB-172) book like judge spend: wallet (meter + budget), never
  // feedback's actual_cost_usd. Late-bound — the agent doesn't exist yet at tool construction.
  let bookSearchFee: (usd: number, toolCallId: string) => void = () => {};
  // P3 edit guard: the ledger exists from tool construction but stays fail-open (inert)
  // until the DB + run id attach below — the same late-bind pattern as bookSearchFee.
  const seenLedger = config.editGuard ? new SeenLedger() : undefined;
  const tools = toolsFor(
    args,
    config.bigPlan === true,
    todoState,
    (usd, id) => bookSearchFee(usd, id),
    artifactStore ?? undefined,
    seenLedger,
    bgJobRegistry ?? undefined,
  );
  const systemPrompt = buildSystemPrompt(process.cwd());

  // Judge: sampled LLM grading is ON by default (config.judgeSampleRate, ~15% of
  // ungated turns) whenever a RUNNABLE judge model exists — the configured model when
  // its provider key is present, else the first runnable cheap fallback (buildJudge).
  // Judge spend books to the session wallet (meter overhead + budget) but NEVER into
  // feedback's actual_cost_usd — folding it in would inflate the routed model's observed
  // $/call and poison the observed/rescaled cost basis. Late-bound: the agent (and its
  // optional budget) doesn't exist yet at judge construction.
  let bookJudgeSpend: (usd: number) => void = () => {};
  const built = buildJudge(config, (usd) => bookJudgeSpend(usd));
  const judge = built.judge;
  for (const notice of built.notices) {
    process.stderr.write(`minima: ${notice}\n`);
  }

  // Classifier (MINIMA_TUI_CLASSIFY=1, default OFF): one cheap completion labels each
  // interactive lead prompt before routing (caller-override wire seam). Same runnable-
  // model resolution as the judge; spend books to the wallet like judge spend, never
  // into feedback's actual_cost_usd. No runnable model → the feature stays off.
  let bookClassifySpend: (usd: number) => void = () => {};
  let classifier: TaskClassifier | null = null;
  if (config.classify) {
    const preferred = config.classifyModel ?? CHEAP_FALLBACK_MODELS[0]!;
    const resolved = resolveRunnableModel(preferred);
    if (resolved) {
      classifier = new TaskClassifier(resolved.model, {
        onCostUsd: (usd) => bookClassifySpend(usd),
      });
      if (resolved.substituted) {
        process.stderr.write(
          `minima: classifier model ${preferred} has no provider key — using ${resolved.model.id} instead\n`,
        );
      }
    } else {
      process.stderr.write(
        "minima: client-side classification ignored (no runnable classifier model — provider key missing)\n",
      );
    }
  }

  const agent = new MinimaAgent({
    config,
    tools,
    meter: new CostMeter(),
    judge,
    systemPrompt,
  });
  // Hook-order contract (P2): bash-steer registers FIRST on the beforeToolCall stack —
  // ahead of the TUI permission hook (app.tsx) and the headless checkpoint/done-gate
  // hooks below. First block wins, so a steered command never raises a pointless
  // permission overlay. Keep this line immediately after agent construction.
  agent.addBeforeToolCall(makeBashSteerHook(config));
  // W3.3: a successful tool call whose `path` argument resolves into the artifact dir
  // bumps that row's last_used, so paged-back artifacts survive the LRU prune longest.
  if (artifactStore) agent.addAfterToolCall(makeArtifactReadTouchHook(artifactStore));
  // W5.1: an edit/write/apply_patch success appends the just-edited file's LSP diagnostics
  // (opt-in; null when config.lsp is off, so the hook is never in the fold).
  if (lspManager)
    agent.addAfterToolCall(makeLspDiagnosticsHook(lspManager, { workdir: process.cwd() }));
  // W4.5: compaction spills the pruned window through this same store (null when artifacts
  // are off → v1 byte-identical); attach()-ed below before any compaction can fire.
  agent.artifacts = artifactStore;
  // agent.budget is attached later (--budget) — read it at call time. Children share this
  // judge instance (spawn.ts), so their grading books here too, never into their own
  // meter rows (which the parent reads as the child's routed cost).
  bookJudgeSpend = (usd) => {
    agent.meter?.addOverhead(usd);
    agent.budget?.bookSpend(usd, "judge");
  };
  agent.classifier = classifier;
  bookClassifySpend = (usd) => {
    agent.meter?.addOverhead(usd);
    agent.budget?.bookSpend(usd, "classify");
  };
  bookSearchFee = (usd, toolCallId) => {
    agent.meter?.bookToolFee(toolCallId, usd);
    agent.budget?.bookSpend(usd, "web_search");
  };
  // Apply the --thinking CLI flag to the initial reasoning level. It was parsed but never used;
  // the agent kept its default, so the flag was a silent no-op.
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (THINKING_LEVELS.includes(args.thinking)) {
    agent.agentState.thinkingLevel = args.thinking as typeof agent.agentState.thinkingLevel;
  }

  // Effort routing Phase A (staged default-off): the server's classified difficulty picks
  // each prompt's thinking level — routing (model, effort), not just model. Resolved in
  // config (MINIMA_AUTO_EFFORT through the experimental umbrella).
  agent.autoEffort = config.autoEffort;

  // Wire Mubit memory (recall-before-route + write-back) into the agent. No-op unless a
  // MUBIT_API_KEY is present. Use a STABLE per-repo memory session id (the provisioned project
  // namespace, else the repo identity) so recall surfaces prior outcomes across runs and
  // write-backs accumulate under it — random-per-run ids would make recall see nothing.
  const memorySession = config.namespace ?? repoIdentity(process.cwd());
  // Also scope server-side recall (/v1/recommend) to this stable id: prod memory is keyed
  // by user_id, so without it decision_basis can never leave `prior`. router.ts reads
  // config.memorySession by reference at recommend time.
  config.memorySession = memorySession;
  agent.memory = await createMubitMemory(memorySession);

  // Persistence spine: open the local DB, register {project_key, run_id}, and attach the
  // event sink + DecisionRecord writer. Fail-open — a broken DB never blocks a run — EXCEPT
  // --resume, where continuing without the store would silently start a fresh session.
  let db: MinimaDb | null = null;
  let sink: DbSinkHandle | null = null;
  let initialResume: RehydratedRun | null = null;
  let bigPlanGateBefore: BeforeToolCall | null = null;
  // B2 memory scribe: drains queued curation jobs (built once db + agent exist; reads
  // agent.budget at call time since --budget attaches it later).
  let scribeDrain: (() => Promise<void>) | null = null;
  // E1 diff reviewer: late-bound — the plan hooks are built before the plan meta model
  // exists, so closure events route through this ref; the reviewer is armed further down.
  const planClosedRef: { current: ((planId: string) => void) | null } = { current: null };
  let pendingDiffReview: Promise<unknown> | null = null;
  const verifyConsentRef: { current: VerifyConsent } = { current: headlessVerifyConsent() };
  try {
    db = new MinimaDb();
    const projectKey = repoIdentity(process.cwd());
    db.ensureProject(projectKey, config.namespace ?? null);
    // Resolve --resume BEFORE startRun so a typo never leaves a stray 'active' run row.
    let resumeFrom: RunRow | null = null;
    if (args.resume) {
      resumeFrom = db.findRunByName(projectKey, args.resume);
      if (!resumeFrom) {
        const near = db.searchRuns(projectKey, args.resume);
        process.stderr.write(
          `minima: no session matching "${args.resume}"\n${
            near.length
              ? `${near
                  .map((r) => `  ${r.run_id.slice(0, 12)}  ${r.display_name ?? "(unnamed)"}`)
                  .join("\n")}\n`
              : "  (no near matches — run /resume inside minima to browse sessions)\n"
          }`,
        );
        db.close();
        return 2;
      }
    }
    const runId = db.startRun({
      projectKey,
      providerSessionId: agent.sessionId,
      gitBaseSha: gitHeadSha(process.cwd()),
    });
    agent.db = db;
    agent.runId = runId;
    artifactStore?.attach(db, runId);
    bgJobRegistry?.attach(db, runId);
    seenLedger?.attach(db, runId);
    sink = attachDbSink(agent, db, { runId });
    if (resumeFrom) {
      // Same shape as the interactive /resume path: context + meter + judge cadence,
      // with lineage recorded on the new run. Rehydrated BEFORE first render.
      initialResume = rehydrateRun(db, resumeFrom.run_id);
      applyRehydratedRun(agent, initialResume);
      db.setRunParent(runId, resumeFrom.run_id);
      // D2: re-run the in-progress step's verify against its recorded baseline (the
      // working tree may have moved while the session was away). Consent-gated like every
      // verify (headless: MINIMA_TUI_ALLOW_VERIFY=1); warn-only, never blocks the resume.
      if (config.bigPlan) {
        const rv = await reverifyOnResume({
          db,
          planSessionId: resumeFrom.run_id,
          eventRunId: runId,
          consent: (cmd) => verifyConsentRef.current(cmd),
        });
        const note = reverifyNotice(rv);
        if (note) process.stderr.write(`minima: ${note}\n`);
      }
    }
    // Plan ledger (M1.1/M2.1/M2.2) + done-gate (M4.1–M4.3): after each tool call the
    // sink keeps the SQLite plan of record in step with what the agent actually did (plan
    // upsert, baseline capture, on_plan/off_plan file changes) and writes gate rows; before
    // each todowrite the gate refuses completions whose `verify` does not pass. Off unless
    // MINIMA_TUI_BIG_PLAN=1. Bookkeeping stays fail-open (reads live agent.db/agent.runId;
    // swallows its own errors); only the gate's check verdicts fail closed. The before-hook is
    // registered later — headless below, or by the TUI AFTER its permission hook so permission
    // always runs first (first block wins) and no check runs on a call the user would deny.
    if (config.bigPlan) {
      // MP18: verify commands are LLM-authored shell — bash-class scrutiny. The ref starts
      // as the headless checker (deny-all unless MINIMA_TUI_ALLOW_VERIFY=1, fail-CLOSED);
      // the TUI swaps in its permission-state-backed checker on mount, so interactive runs
      // consent per exact command via the existing overlay and -p runs never execute an
      // unapproved check.
      const { before, after } = bigPlanHooks(agent, {
        enforceAllowlist: config.toolAllowlist,
        verifyConsent: (cmd) => verifyConsentRef.current(cmd),
        onPlanClosed: (planId) => planClosedRef.current?.(planId),
      });
      agent.addAfterToolCall(after);
      bigPlanGateBefore = before;
    }
    // B2 memory scribe: recover jobs a crashed process left `running`, build the drain
    // (routed extraction, spend booked like judge spend), and clear prior sessions'
    // leftovers shortly after startup — off the critical path, fail-open throughout.
    if (config.memoryLedger) {
      const scribeDb = db;
      scribeDb.requeueRunningMemoryJobs();
      scribeDrain = async () => {
        try {
          await drainMemoryJobs({
            db: scribeDb,
            extract: makeRoutedExtractor({
              router: agent.router,
              meter: agent.meter,
              budget: agent.budget,
            }),
            budget: agent.budget,
            modelExists: (id) => findModelById(id) !== undefined,
            projectKeyFor: (job) =>
              (job.session_id ? scribeDb.getRun(job.session_id)?.project_key : null) ?? projectKey,
          });
        } catch {
          // curation must never break a run
        }
      };
      const startupDrain = setTimeout(() => void scribeDrain?.(), 3000);
      startupDrain.unref?.();
    }
  } catch (exc) {
    if (args.resume) {
      process.stderr.write(`minima: cannot --resume: persistence unavailable: ${errText(exc)}\n`);
      return 2;
    }
    process.stderr.write(`minima: persistence disabled: ${errText(exc)}\n`);
    db = null;
  }
  const closeDb = (status: "done" | "aborted" = "done"): void => {
    try {
      // Orphan policy (W4.1): kill every live background job's group and durably mark it
      // `killed` before the DB closes; the reaper handles any TERM-ignoring survivor next start.
      bgJobRegistry?.shutdown();
      // W5.1: kill every spawned language server (idempotent) before the DB closes.
      lspManager?.shutdown();
      sink?.detach();
      if (db && agent.runId) db.finishRun(agent.runId, status);
      db?.close();
    } catch {
      // shutdown must never fail on bookkeeping
    }
  };
  // E1: an in-flight diff review gets a bounded window at exit to land its verdict gate;
  // one that can't finish simply writes nothing (advisory — a skip never degrades a tier).
  const settleDiffReview = async (): Promise<void> => {
    if (!pendingDiffReview) return;
    try {
      await Promise.race([pendingDiffReview, new Promise<void>((r) => setTimeout(r, 8000))]);
    } catch {
      // advisory — never delay shutdown on an error
    }
  };
  // B2: session end enqueues one reflect job and gives the drain a bounded window; a pass
  // that can't finish here stays queued and the next session's startup drain runs it.
  const endScribeSafely = async (): Promise<void> => {
    if (!db || !agent.runId || !scribeDrain) return;
    try {
      db.enqueueMemoryJob({ kind: "reflect", sessionId: agent.runId });
      await Promise.race([scribeDrain(), new Promise<void>((r) => setTimeout(r, 8000))]);
    } catch {
      // curation is optional — never delay shutdown on an error
    }
  };

  // Orchestration: the lead (depth 0) can delegate subtasks to cost-routed child agents.
  // Children get their own routed model, meter, confined tools, and budget slice; their
  // rows land in the same run under agentId=childId.
  //
  // childEventRef: mutable handler set by HarnessApp on mount so sub-agent events reach
  // React state without the TUI needing to exist at createSpawn time.
  const childEventRef: { handler: ((e: ChildEvent) => void) | null } = { handler: null };
  const spawnFactory = createSpawn({
    parent: agent,
    workdir: process.cwd(),
    onChildEvent: (e) => childEventRef.handler?.(e),
    artifacts: artifactStore ?? undefined,
  });
  agent.agentState.tools.push(
    taskTool({
      spawn: spawnFactory,
      spawnDepth: 0,
      maxDepth: 2,
      typedTask: config.typedTask,
    }),
  );

  // Fixed cheap model the plan-mode council uses for keeper/critic/synth completions.
  const planMetaModel = findModelById(agent.config.judgeModel) ?? agent.mapping.defaultModel();

  // Plan-premium startup advisory: the hard failure fires at plan usage (resolved per turn
  // so /auth mid-session counts); this just tells the user at launch instead of first /plan.
  if (config.planPremium && !config.pinned) {
    try {
      resolvePlanModels(config);
    } catch (exc) {
      process.stderr.write(`minima: plan-premium warning — ${errText(exc)}\n`);
    }
  }

  // E1 zero-context diff reviewer: when a plan closes with every step completed, review
  // the run's whole diff with fresh eyes (one cheap completion — no plan, no transcript).
  // Fire-and-forget off the tool dispatch; the exits await it briefly so a one-shot run
  // still lands its verdict gate. MINIMA_TUI_DIFF_REVIEW=0 opts out.
  if (
    process.env.MINIMA_TUI_DIFF_REVIEW !== "0" &&
    config.bigPlan &&
    db &&
    providerKeyPresent(planMetaModel.provider)
  ) {
    const reviewDb = db;
    const reviewTop = detectRepo(process.cwd());
    planClosedRef.current = (planId) => {
      if (!reviewTop || !agent.runId) return;
      const run = reviewDb.getRun(agent.runId);
      pendingDiffReview = runDiffReview({
        db: reviewDb,
        sessionId: agent.runId,
        planId,
        metaModel: planMetaModel,
        diff: collectRunDiff(reviewTop, run?.git_base_sha ?? null),
        onCostUsd: (usd) => {
          agent.meter?.addOverhead(usd);
          agent.budget?.bookSpend(usd, "diff-review");
        },
      }).catch(() => null);
    };
  }

  // PR-E observer: a non-blocking watcher over the event stream — deterministic tripwires
  // + a sampled adversarial pass, surfacing only as steers / audit rows / at most one
  // yellow milestone gate. Opt-in (MINIMA_TUI_OBSERVER=1); the default path attaches
  // nothing — no listener, no drain, zero DB writes. Spend books like judge spend.
  let observerHandle: ObserverHandle | null = null;
  if (db && agent.runId) {
    observerHandle = maybeAttachObserver(config, {
      agent,
      db,
      runId: agent.runId,
      metaModel: providerKeyPresent(planMetaModel.provider) ? planMetaModel : null,
      recId: () => agent.currentRecId,
      budget: () => agent.budget,
      onCostUsd: (usd) => {
        agent.meter?.addOverhead(usd);
        agent.budget?.bookSpend(usd, "observer");
      },
    });
  }
  // The observer's drain gets a bounded window at exit to land its verdicts; anything it
  // can't finish is simply dropped (advisory — a lost verdict never degrades anything).
  const endObserverSafely = async (): Promise<void> => {
    if (!observerHandle) return;
    try {
      await Promise.race([observerHandle.stop(), new Promise<void>((r) => setTimeout(r, 5000))]);
    } catch {
      // advisory — never delay shutdown on an error
    }
  };

  // The `question` tool lets the model ask the user a structured clarifying question mid-run.
  // The ask callback is late-bound: the TUI populates askUserRef.current once it mounts an
  // overlay; in headless/print modes it stays null and the tool tells the model to proceed.
  const askUserRef: AskUserRef = { current: null };
  agent.agentState.tools.push(questionTool(askUserRef));
  // P4 checkpoint/rewind: flag gates REGISTRATION only — rehydrate honors persisted
  // context_rewind markers regardless (they are data about what the model saw).
  registerContextRewindTools(agent.agentState.tools, config.contextRewind, {
    getState: () => agent.agentState,
    db,
    getRunId: () => agent.runId,
  });
  // A2 stop-gate: the run-level gate raises the "keep going / accept / steer" overlay through the
  // same late-bound ask channel once its strikes are spent (null in headless → the run just ends).
  agent.askUser = askUserRef;

  // Preference probe (tuner, opt-in MINIMA_TUI_TUNER=1): the SAME plan-closed seam as the
  // diff reviewer — after a plan closes fully completed, at most one bounded slider A/B
  // question per session (7-day cooldown via profile_events). Composes with the reviewer's
  // handler; every gate fails open and silent, and headless runs skip (no overlay).
  if (config.tuner && db) {
    const probe = createPreferenceProbe({
      db,
      projectKey: repoIdentity(process.cwd()),
      tuner: config.tuner,
      defaultSlider: config.costQualityTradeoff,
      askUser: askUserRef,
    });
    const prevPlanClosed = planClosedRef.current;
    planClosedRef.current = (planId) => {
      prevPlanClosed?.(planId);
      void probe();
    };
  }

  // D1 (v13): stamp every subsequent decision/gate with the running harness + toolset
  // digest — set here, AFTER the toolset is final (task/question tools included). Resume
  // compares a run's recorded stamp against this one (warn-only, never a block).
  if (db) {
    db.setVersionStamp({
      harnessVersion: VERSION,
      toolSchemaHash: toolSchemaHash(agent.agentState.tools),
    });
    if (initialResume) {
      const recorded = db.lastRecordedStamp(initialResume.run.run_id);
      const current = db.versionStamp;
      if (
        recorded.toolSchemaHash &&
        current.toolSchemaHash &&
        recorded.toolSchemaHash !== current.toolSchemaHash
      ) {
        process.stderr.write(
          `minima: 🟡 resumed run was recorded under different tooling (harness ${recorded.harnessVersion ?? "?"} → ${current.harnessVersion ?? "?"}) — history may replay imperfectly\n`,
        );
        try {
          if (agent.runId) {
            db.appendEvent({
              runId: agent.runId,
              type: "tooling_mismatch",
              payload: {
                resumed_run: initialResume.run.run_id,
                recorded_hash: recorded.toolSchemaHash,
                current_hash: current.toolSchemaHash,
                recorded_version: recorded.harnessVersion,
                current_version: current.harnessVersion,
              },
            });
          }
        } catch {
          // advisory bookkeeping
        }
      }
    }
  }

  // Budget following: --budget creates a session-scoped ledger (warn mode unless
  // --budget-enforce). Threshold events surface to stderr in non-interactive modes; the
  // TUI renders them as chat notices.
  if (args.budgetUsd !== undefined && db && agent.runId) {
    agent.budget = new BudgetLedger({
      db,
      scopeKey: `session:${agent.runId}`,
      limitUsd: args.budgetUsd,
      mode: args.budgetEnforce ? "enforce" : "warn",
      runId: agent.runId,
    });
  } else if (args.budgetUsd !== undefined) {
    process.stderr.write("minima: --budget ignored (persistence unavailable)\n");
  }

  const nonInteractive = args.print || args.mode === "print" || args.mode === "json";
  // Headless: budget signals go to stderr. (The TUI re-targets them to chat notices.)
  if (nonInteractive && agent.budget) {
    agent.budget.setOnEvent((e) => {
      if (e.kind === "threshold" || e.kind === "deny") {
        process.stderr.write(`minima: ${e.note ?? e.kind}\n`);
      }
    });
  }
  // Headless has no permission hook, so B3's checkpoint hook registers first (snapshot
  // before the done-gate can block) and the done-gate second — same relative order as the
  // TUI's stack. One-shot run = one prompt, so arm once here.
  if (nonInteractive && agent.db) {
    const headlessTop = detectRepo(process.cwd());
    const ckpt = makeCheckpointHook({
      top: headlessTop,
      db: agent.db,
      getRunId: () => agent.runId,
      notify: (message) => process.stderr.write(`minima: ${message}\n`),
    });
    agent.addBeforeToolCall(ckpt.hook);
    ckpt.arm();
  }
  // Headless has no permission hook, so the done-gate registers after the checkpoint hook.
  if (nonInteractive && bigPlanGateBefore) agent.addBeforeToolCall(bigPlanGateBefore);
  if (nonInteractive) {
    const prompt = args.prompt.join(" ").trim();
    if (!prompt) {
      process.stderr.write("minima: --print/--mode json requires a prompt\n");
      await endObserverSafely();
      closeDb("aborted");
      return 2;
    }
    // finally-guarded: a thrown run error (e.g. budget-enforce refusal) must still finish
    // the run row + close the DB, or the run leaks as 'active'.
    let rc = 1;
    try {
      rc = args.mode === "json" ? await runJson(agent, prompt) : await runPrint(agent, prompt);
    } catch (exc) {
      process.stderr.write(`minima: ${errText(exc)}\n`);
      rc = 1;
    } finally {
      await endSessionSafely(agent); // distil the one-shot run into durable memory
      await endObserverSafely(); // let the observer drain land its remaining verdicts
      await endScribeSafely(); // curate the run's ledger signals into the memory ledger
      await settleDiffReview(); // let an in-flight closure review land its gate
      closeDb(rc === 0 ? "done" : "aborted");
    }
    return rc;
  }

  // Shift+Tab permission mode for the interactive TUI: the CLI flag wins; otherwise restore
  // this project's last persisted mode (build when none). Bypass is never persisted — a
  // session always boots into a non-bypass mode unless the flag asks for it.
  if (args.bypassPermissions) {
    setMode("bypass");
  } else {
    const savedMode = loadPersistedMode(repoIdentity(process.cwd()));
    if (savedMode) setMode(savedMode);
  }

  // B2 quiet-timer: ~90s of tool-call silence marks a natural pause — enqueue a reflect
  // job and drain in the background. unref'd so the timer never keeps the process alive.
  if (scribeDrain && db) {
    const quietDb = db;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    agent.addAfterToolCall(async () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => {
        try {
          if (agent.runId) quietDb.enqueueMemoryJob({ kind: "reflect", sessionId: agent.runId });
        } catch {
          // fail-open
        }
        void scribeDrain?.();
      }, 90_000);
      quiet.unref?.();
      return null;
    });
  }

  // One renderer — inline (like Claude Code's REPL): main buffer + Ink <Static> commits finished
  // output to the terminal's NATIVE scrollback, so wheel scroll + click-drag select + copy are
  // all the terminal's own — simultaneously, no mouse capture. installInputFilter strips stray
  // wheel SGR + captures bracketed pastes before Ink's key parser sees them.
  installInputFilter();
  if (process.env.MINIMA_TUI_DEBUG_ANCHOR) {
    installAnchorWriteTap(process.env.MINIMA_TUI_DEBUG_ANCHOR);
  }
  process.stdout.write("\u001b[?2004h"); // bracketed paste: pastes arrive as one marked block
  // DECSTBM reset FIRST (CSI r): a previous program that pinned its UI with scroll
  // margins and died without resetting leaves the region in the WINDOW forever — margins
  // survive 2J/3J/H and even resizes, so every newline the reserve writes scrolls inside
  // the stale region and the composer seats mid-screen (root-caused live 2026-07-20: a
  // window carried margins 1–24 from an earlier CLI; DSR said row 24 after a 59-newline
  // reserve; one CSI r restored row 60). CSI ?69l drops any leaked left/right margins
  // (DECLRMM) the same way. Then clear like Claude Code: full clear for a clean-slate
  // "own app" feel — erase-display(2)
  // wipes the visible screen, erase-display(3) drops the prior scrollback (so no leftover shell
  // history or a previous session sits above us), cursor-home rewinds to the top. The banner +
  // input render from the TOP and grow downward; Ink commits finished output to native
  // scrollback as the session runs, so scroll-up + click-drag select still work WITHIN it.
  process.stdout.write("\u001b[r\u001b[?69l\u001b[2J\u001b[3J\u001b[H");
  // Top-anchored transcript (R1, 2026-07-22 — reverses THE RULE's rows-1 newline reserve):
  // the cursor stays at HOME after the clear, so <Static> prints the banner from the TOP of
  // the fresh screen and the transcript grows DOWNWARD under it, Claude-Code-style. The
  // composer still seats at the bottom: the anchor ledger cap-seeds every reset frame
  // (app.tsx) — a full-height flex-end live frame owns the middle gap, and the floor decays
  // as commits land so the frame shrinks from the top until native scrolling takes over.
  // Enforced by render-buffer.test.ts + tui-verify's first-prompt/bottom-anchor checks.
  // Then hide the cursor (TextInput draws its own).
  // MINIMA_TUI_DEBUG_ANCHOR=<file>: record what the boot clear saw. Pairs with the
  // per-render ledger probe in app.tsx.
  if (process.env.MINIMA_TUI_DEBUG_ANCHOR) {
    try {
      appendFileSync(
        process.env.MINIMA_TUI_DEBUG_ANCHOR,
        `${JSON.stringify({
          t: Date.now(),
          phase: "boot",
          rows: process.stdout.rows ?? null,
          cols: process.stdout.columns ?? null,
          tty: process.stdout.isTTY === true,
          term: process.env.TERM ?? null,
        })}\n`,
      );
    } catch {}
  }
  process.stdout.write("\u001b[?25l");

  if (process.env.MINIMA_TUI_DEBUG_ANCHOR) {
    await probeCursorRow(process.env.MINIMA_TUI_DEBUG_ANCHOR);
  }

  // Interactive TUI: render and block until the app exits (Ctrl+C twice), so the process
  // stays alive for Ink's event loop. Returning here would let the bootstrap exit() kill it.
  // exitOnCtrlC:false hands Ctrl+C to our own useInput handler — during a run it aborts the
  // turn, when idle it arms the double-press quit — instead of Ink killing the app outright.
  const instance = render(
    React.createElement(HarnessApp, {
      agent,
      banner: "minima",
      askUserRef,
      childEventRef,
      initialResume,
      planSpawn: spawnFactory,
      planMetaModel,
      bigPlanGateBefore,
      verifyConsentRef,
      todos: todoState,
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();

  // Shutdown: drop bracketed paste, restore cursor.
  process.stdout.write("\u001b[?2004l");
  process.stdout.write("\u001b[?25h");
  await endSessionSafely(agent); // reflect + checkpoint this session into durable memory
  await endObserverSafely(); // let the observer drain land its remaining verdicts
  await endScribeSafely(); // curate the run's ledger signals into the memory ledger
  await settleDiffReview(); // let an in-flight closure review land its gate
  closeDb("done");
  return 0;
}

/** Best-effort HEAD sha for run provenance (null outside a git repo). */
function gitHeadSha(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
    const out = proc.stdout.toString().trim();
    return proc.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/** Distil the run into durable Mubit memory on exit, time-boxed so it never hangs shutdown. */
async function endSessionSafely(agent: MinimaAgent): Promise<void> {
  await Promise.race([agent.endSession(), new Promise<void>((r) => setTimeout(r, 5000))]);
}

function findModelByIdLocal(id: string) {
  return findModelById(id);
}

/** `minima config` — list stored values (masked) + set/unset a key, no TUI required. */
async function configCli(args: string[]): Promise<number> {
  if (args[0] === "set") {
    const [key, ...rest] = args.slice(1);
    if (!key) {
      process.stderr.write("usage: minima config set <KEY> <value>\n");
      return 2;
    }
    const backend = await storeSetValue(key, rest.join(" "));
    process.stdout.write(`stored ${key} (${backend})\n`);
    return 0;
  }
  if (args[0] === "get") {
    const key = args[1];
    if (!key) {
      process.stderr.write("usage: minima config get <KEY>\n");
      return 2;
    }
    process.stdout.write(`${(await storeGet(key)) ?? ""}\n`);
    return 0;
  }
  // default: list all configurable fields with masked secrets.
  for (const section of SECTIONS) {
    process.stdout.write(`\n# ${section.title}\n`);
    for (const f of section.fields) {
      const val = await storeGet(f.key);
      const shown = f.secret ? mask(val) : (val ?? "");
      process.stdout.write(`${f.key}=${shown}\n`);
    }
  }
  process.stdout.write("\nUse `minima config set <KEY> <value>` to store a credential.\n");
  return 0;
}

/** `minima auth` — browser login → provision this repo's Mubit project → store the key. */
async function authCli(args: string[]): Promise<number> {
  const region = args.includes("--region")
    ? (args[args.indexOf("--region") + 1] as "eu" | "us" | undefined)
    : undefined;
  const cwd = process.cwd();
  const repo = repoIdentity(cwd);
  const consoleUrl = process.env.MUBIT_CONSOLE_URL?.trim() || DEFAULT_CONSOLE_URL;

  process.stdout.write(`minima auth — provisioning a Mubit project for ${repo}\n`);
  try {
    const result = await runAuth({
      repo,
      consoleUrl,
      region: region === "eu" || region === "us" ? region : undefined,
      onUrl: (u) =>
        process.stdout.write(
          `\nOpening your browser to authorize:\n  ${u}\n\n(If it didn't open, paste that URL into your browser.)\n`,
        ),
    });
    await storeSetValue("MUBIT_API_KEY", result.mubitApiKey);
    if (result.minimaUrl) await storeSetValue("MINIMA_URL", result.minimaUrl);
    await setProject(repo, {
      instanceId: result.instanceId,
      projectId: result.projectId,
      namespace: result.namespace,
      minimaUrl: result.minimaUrl,
    });
    process.stdout.write(
      `\n✅ Authorized. MUBIT_API_KEY stored (${mask(result.mubitApiKey)}).\n   project: ${result.projectId}  ·  instance: ${result.instanceId}\n   Run \`minima\` to start.\n`,
    );
    return 0;
  } catch (exc) {
    if (exc instanceof ProvisioningPending) {
      process.stdout.write(
        "\n⏳ Your Minima workspace is provisioning (~1-2 min). " +
          "Re-run `minima auth` shortly — it'll pick up where it left off.\n",
      );
      return 0;
    }
    process.stderr.write(
      `\nminima auth failed: ${exc instanceof Error ? exc.message : String(exc)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((exc) => {
      process.stderr.write(`minima: ${errText(exc)}\n`);
      process.exit(1);
    });
}
