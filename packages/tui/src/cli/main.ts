/**
 * `minima` CLI entry point — port of minima_harness/tui/cli.py.
 *
 * Parses args, loads .env, builds the HarnessConfig + toolset + MinimaAgent, and
 * dispatches to one of: --print (one-shot), --mode json (event stream), or the
 * interactive Ink TUI (default). The Python recommender service stays in Python;
 * this binary only needs a MUBIT_API_KEY (routing) + a provider key (calling).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "ink";
import React from "react";
import { ensureProvidersRegistered } from "../ai/providers/index.ts";
import { registerModel } from "../ai/registry.ts";
import type { Model } from "../ai/types.ts";
import { errText } from "../errtext.ts";
import { CostMeter, type HarnessConfig, MinimaAgent, configFromEnv } from "../minima/index.ts";
import { ConstJudge } from "../minima/index.ts";
import { createMubitMemory } from "../minima/mubit_memory_factory.ts";
import { runJson, runPrint } from "../run_modes.ts";
import { builtinTools } from "../tools/index.ts";
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
interface CliArgs {
  prompt: string[];
  model?: string;
  provider?: string;
  thinking: string;
  offline: boolean;
  print: boolean;
  mode: "interactive" | "print" | "json";
  tools?: string;
  excludeTools?: string;
  noTools: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {
    prompt: [],
    thinking: "off",
    offline: false,
    print: false,
    mode: "interactive",
    noTools: false,
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
      case "--thinking":
        opts.thinking = take(i++);
        break;
      case "--offline":
        opts.offline = true;
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
      --thinking LEVEL     off|minimal|low|medium|high|xhigh
      --offline            bypass Minima routing
  -t, --tools LIST         comma-separated tool allowlist
  -xt, --exclude-tools LIST
  -nt, --no-tools
  -h, --help
`;

function toolsFor(args: CliArgs) {
  let tools = args.noTools ? [] : builtinTools();
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
  const tools = toolsFor(args);
  const systemPrompt = buildSystemPrompt(process.cwd());

  const agent = new MinimaAgent({
    config,
    tools,
    meter: new CostMeter(),
    judge: new ConstJudge(null), // abstain by default in the CLI; wire an LLMJudge later
    systemPrompt,
  });

  // Wire Mubit memory (recall-before-route + write-back) into the agent. No-op unless a
  // MUBIT_API_KEY is present, so the harness is unchanged when Mubit isn't configured.
  agent.memory = await createMubitMemory(randomUUID());

  const nonInteractive = args.print || args.mode === "print" || args.mode === "json";
  if (nonInteractive) {
    const prompt = args.prompt.join(" ").trim();
    if (!prompt) {
      process.stderr.write("minima: --print/--mode json requires a prompt\n");
      return 2;
    }
    const rc = args.mode === "json" ? await runJson(agent, prompt) : await runPrint(agent, prompt);
    await endSessionSafely(agent); // distil the one-shot run into durable memory
    return rc;
  }

  // Install the stdin.read() filter so SGR mouse wheel sequences are stripped
  // before Ink's parseKeypress ever sees them (prevents garbage in TextInput).
  installMouseScrollFilter();

  // Enter alternate screen + hide cursor BEFORE render() so Ink's first paint
  // lands in the alternate buffer (otherwise the screen is blank until a key is pressed).
  process.stdout.write("\u001b[?1049h");
  process.stdout.write("\u001b[?25l");

  // Interactive TUI: render and block until the app exits (Ctrl+C twice), so the process
  // stays alive for Ink's event loop. Returning here would let the bootstrap exit() kill it.
  const instance = render(React.createElement(HarnessApp, { agent, banner: "minima" }));
  await instance.waitUntilExit();

  // Exit alternate screen + restore cursor on shutdown.
  process.stdout.write("\u001b[?1049l");
  process.stdout.write("\u001b[?25h");
  await endSessionSafely(agent); // reflect + checkpoint this session into durable memory
  return 0;
}

/** Distil the run into durable Mubit memory on exit, time-boxed so it never hangs shutdown. */
async function endSessionSafely(agent: MinimaAgent): Promise<void> {
  await Promise.race([agent.endSession(), new Promise<void>((r) => setTimeout(r, 5000))]);
}

// local re-export to avoid a cycle through the barrel
import { findModelById } from "../ai/registry.ts";
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
