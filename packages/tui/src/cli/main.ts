/**
 * `minima` CLI entry point — port of the Python harness's tui/cli.py.
 *
 * Parses args, loads .env, builds the HarnessConfig + toolset + MinimaAgent, and
 * dispatches to one of: --print (one-shot), --mode json (event stream), or the
 * interactive Ink TUI (default). The Python recommender service stays in Python;
 * this binary only needs a MUBIT_API_KEY (routing) + a provider key (calling).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "ink";
import React from "react";
import type { BeforeToolCall } from "../agent/tools.ts";
import { providerKeyPresent } from "../ai/provider_catalog.ts";
import { ensureProvidersRegistered } from "../ai/providers/index.ts";
import { findModelById, registerModel } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import { MinimaDb, type RunRow } from "../db/minima_db.ts";
import { type RehydratedRun, applyRehydratedRun, rehydrateRun } from "../db/rehydrate.ts";
import { type DbSinkHandle, attachDbSink } from "../db/sink.ts";
import { errText } from "../errtext.ts";
import { BudgetLedger } from "../minima/budget.ts";
import { groundTruthHooks } from "../minima/ground_truth.ts";
import { CostMeter, type HarnessConfig, MinimaAgent, configFromEnv } from "../minima/index.ts";
import { ConstJudge, LLMJudge } from "../minima/index.ts";
import { createMubitMemory } from "../minima/mubit_memory_factory.ts";
import { type ChildEvent, createSpawn } from "../minima/spawn.ts";
import { runJson, runPrint } from "../run_modes.ts";
import { detectRepo, makeCheckpointHook } from "../session/checkpoint.ts";
import { type AskUserRef, builtinTools, questionTool } from "../tools/index.ts";
import { taskTool } from "../tools/task.ts";
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
import { installMouseScrollFilter } from "../tui/mouse-scroll.ts";
import { getProject, repoIdentity, setProject } from "../tui/projects.ts";

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
const SEED_MODELS: Model[] = [
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
    id: "deepseek-chat",
    provider: "deepseek",
    api: "openai-completions",
    name: "DeepSeek V3",
    cost: { input: 0.27, output: 1.1 },
    context_window: 64_000,
    max_tokens: 8_192,
    base_url: "https://api.deepseek.com",
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
    cost: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
    context_window: 200_000,
    max_tokens: 16384,
    reasoning: true,
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
  /**
   * Fullscreen renderer: alternate screen buffer, prompt glued to the bottom row, in-app scroll
   * (PgUp/PgDn + optional mouse wheel) — like Claude Code's fullscreen mode. Default true; disable
   * with `--no-fullscreen` or `MINIMA_TUI_INLINE=1` to fall back to the inline/native-scroll mode.
   */
  fullscreen: boolean;
  /** Resume a previous session by display name or run-id (prefix ≥ 4 chars). */
  resume?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {
    prompt: [],
    thinking: "off",
    offline: false,
    print: false,
    mode: "interactive",
    noTools: false,
    budgetEnforce: false,
    fullscreen: !process.env.MINIMA_TUI_INLINE,
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
      case "--no-fullscreen":
        opts.fullscreen = false;
        break;
      case "--fullscreen":
        opts.fullscreen = true;
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
      --no-fullscreen      inline renderer (native scroll) instead of the glued-prompt fullscreen UI
  -t, --tools LIST         comma-separated tool allowlist
  -xt, --exclude-tools LIST
  -nt, --no-tools
      --resume NAME|ID     resume a previous session by name or run-id prefix (see /name, /rename)
  -b, --budget USD         session budget (graduated warnings at 50/75/90/100%)
      --budget-enforce     refuse runs once the budget is exhausted (default: warn)
      --slider N           cost/quality 0..10 (0 = cheapest acceptable; default 5)
  -h, --help
`;

function toolsFor(args: CliArgs, groundTruth: boolean) {
  let tools = args.noTools ? [] : builtinTools({ groundTruth });
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

function buildConfig(args: CliArgs): HarnessConfig {
  const cfg = configFromEnv();
  if (args.offline) cfg.minimaUrl = "";
  if (args.model) {
    cfg.candidates = [args.model];
    cfg.pinned = true;
  }
  if (args.slider !== undefined) cfg.costQualityTradeoff = args.slider;
  return cfg;
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
  const tools = toolsFor(args, config.groundTruth === true);
  const systemPrompt = buildSystemPrompt(process.cwd());

  // Judge: abstains by default (honest — no fabricated quality). MINIMA_LLM_JUDGE=1 turns
  // on real LLM grading (staged default-off: it spends money where ConstJudge spent zero).
  // Judge spend books to the session wallet (meter overhead + budget) but NEVER into
  // feedback's actual_cost_usd — folding it in would inflate the routed model's observed
  // $/call and poison the observed/rescaled cost basis. Late-bound: the agent (and its
  // optional budget) doesn't exist yet at judge construction.
  let bookJudgeSpend: (usd: number) => void = () => {};
  let judge: ConstJudge | LLMJudge = new ConstJudge(null);
  if (process.env.MINIMA_LLM_JUDGE === "1") {
    const jm = findModelById(config.judgeModel);
    if (jm && providerKeyPresent(jm.provider)) {
      judge = new LLMJudge(jm, { onCostUsd: (usd) => bookJudgeSpend(usd) });
      process.stderr.write(
        `minima: LLM judge on (${jm.id}) — grading adds a small per-prompt cost (booked to /cost + budget)\n`,
      );
    } else {
      process.stderr.write(
        `minima: MINIMA_LLM_JUDGE=1 ignored (judge model ${config.judgeModel} unavailable or key missing)\n`,
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
  // agent.budget is attached later (--budget) — read it at call time. Children share this
  // judge instance (spawn.ts), so their grading books here too, never into their own
  // meter rows (which the parent reads as the child's routed cost).
  bookJudgeSpend = (usd) => {
    agent.meter?.addOverhead(usd);
    agent.budget?.bookSpend(usd, "judge");
  };
  // Apply the --thinking CLI flag to the initial reasoning level. It was parsed but never used;
  // the agent kept its default, so the flag was a silent no-op.
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (THINKING_LEVELS.includes(args.thinking)) {
    agent.agentState.thinkingLevel = args.thinking as typeof agent.agentState.thinkingLevel;
  }

  // Effort routing Phase A (staged default-off): the server's classified difficulty picks
  // each prompt's thinking level — routing (model, effort), not just model.
  agent.autoEffort = process.env.MINIMA_AUTO_EFFORT === "1";

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
  let gtGateBefore: BeforeToolCall | null = null;
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
    sink = attachDbSink(agent, db, { runId });
    if (resumeFrom) {
      // Same shape as the interactive /resume path: context + meter + judge cadence,
      // with lineage recorded on the new run. Rehydrated BEFORE first render.
      initialResume = rehydrateRun(db, resumeFrom.run_id);
      applyRehydratedRun(agent, initialResume);
      db.setRunParent(runId, resumeFrom.run_id);
    }
    // Ground-Truth ledger (M1.1/M2.1/M2.2) + done-gate (M4.1–M4.3): after each tool call the
    // sink keeps the SQLite plan of record in step with what the agent actually did (plan
    // upsert, baseline capture, on_plan/off_plan file changes) and writes gate rows; before
    // each todowrite the gate refuses completions whose `verify` does not pass. Off unless
    // MINIMA_TUI_GROUND_TRUTH=1. Bookkeeping stays fail-open (reads live agent.db/agent.runId;
    // swallows its own errors); only the gate's check verdicts fail closed. The before-hook is
    // registered later — headless below, or by the TUI AFTER its permission hook so permission
    // always runs first (first block wins) and no check runs on a call the user would deny.
    if (config.groundTruth) {
      const { before, after } = groundTruthHooks(agent, {
        enforceAllowlist: config.toolAllowlist,
      });
      agent.addAfterToolCall(after);
      gtGateBefore = before;
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
      sink?.detach();
      if (db && agent.runId) db.finishRun(agent.runId, status);
      db?.close();
    } catch {
      // shutdown must never fail on bookkeeping
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
  });
  agent.agentState.tools.push(
    taskTool({
      spawn: spawnFactory,
      spawnDepth: 0,
      maxDepth: 2,
    }),
  );

  // Fixed cheap model the plan-mode council uses for keeper/critic/synth completions.
  const planMetaModel = findModelById(agent.config.judgeModel) ?? agent.mapping.defaultModel();

  // The `question` tool lets the model ask the user a structured clarifying question mid-run.
  // The ask callback is late-bound: the TUI populates askUserRef.current once it mounts an
  // overlay; in headless/print modes it stays null and the tool tells the model to proceed.
  const askUserRef: AskUserRef = { current: null };
  agent.agentState.tools.push(questionTool(askUserRef));
  // A2 stop-gate: the run-level gate raises the "keep going / accept / steer" overlay through the
  // same late-bound ask channel once its strikes are spent (null in headless → the run just ends).
  agent.askUser = askUserRef;

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
  if (nonInteractive && gtGateBefore) agent.addBeforeToolCall(gtGateBefore);
  if (nonInteractive) {
    const prompt = args.prompt.join(" ").trim();
    if (!prompt) {
      process.stderr.write("minima: --print/--mode json requires a prompt\n");
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
      closeDb(rc === 0 ? "done" : "aborted");
    }
    return rc;
  }

  // Two renderers (like Claude Code):
  //  - fullscreen (default): alternate screen buffer + hidden cursor. The app draws a full-height
  //    frame with the prompt glued to the bottom row and scrolls history IN-APP (PgUp/PgDn + an
  //    optional captured mouse wheel; installMouseScrollFilter strips wheel SGR before Ink sees it).
  //  - inline (--no-fullscreen / MINIMA_TUI_INLINE=1): main buffer + Ink <Static> commits to the
  //    terminal's NATIVE scrollback (wheel/select/copy are the terminal's own); a one-time newline
  //    reserve seats the prompt at the bottom on first paint.
  if (args.fullscreen) {
    installMouseScrollFilter(); // strip wheel SGR from stdin before Ink's key parser
    process.stdout.write("\u001b[?1049h"); // enter alternate screen
    process.stdout.write("\u001b[?25l"); // hide cursor (TextInput draws its own)
  } else {
    process.stdout.write("\n".repeat(Math.max(0, (process.stdout.rows ?? 24) - 1)));
    process.stdout.write("\u001b[?25l");
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
      fullscreen: args.fullscreen,
      initialResume,
      planSpawn: spawnFactory,
      planMetaModel,
      gtGateBefore,
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();

  // Shutdown: leave the alternate screen (fullscreen only) and always restore the cursor.
  if (args.fullscreen) process.stdout.write("\u001b[?1049l");
  process.stdout.write("\u001b[?25h");
  await endSessionSafely(agent); // reflect + checkpoint this session into durable memory
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
