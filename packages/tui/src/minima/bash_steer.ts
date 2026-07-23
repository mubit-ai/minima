/**
 * P2 — bash-steer rule table (loop robustness).
 *
 * A beforeToolCall hook that blocks the shell spellings of the native tools —
 * cat/head/tail/grep/find/sed -i — with a steer message naming the replacement
 * (read/grep/glob/edit). Enforcement in the dispatcher, never prompt text: the block
 * becomes the tool-error result before bash ever spawns.
 *
 * Matching is deliberately conservative (a false positive is worse than a miss): any
 * shell metacharacter, env-var prefix, or explicit binary path passes through untouched,
 * so pipelines, compounds, heredocs, redirects, and scripts are never blocked — only a
 * single simple command is ever analyzed.
 *
 * PURE + total (mirrors tool_permissions.ts): bashSteerDecision is safe on any string;
 * the hook checks cfg.steer at CALL time so tests//config can toggle without
 * re-registering.
 */

import type { BeforeToolCall } from "../agent/tools.ts";
import type { HarnessConfig } from "./config.ts";

export interface BashSteerBlock {
  block: true;
  nativeTool: string;
  reason: string;
}

const METACHARS = ["\n", "|", "&", ";", ">", "<", "`", "$("];

const FIND_SAFE_FLAGS: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-type",
  "-path",
  "-ipath",
  "-maxdepth",
  "-mindepth",
]);

const BENEFITS: Record<string, string> = {
  grep: "It returns file:line matches, respects .gitignore, and bounds output",
  read: "read(offset, limit) pages any window with numbered, bounded output",
  glob: "glob matches patterns with gitignore filtering and deterministic ordering",
  edit: "edit makes exact, reviewable replacements",
};

function block(firstToken: string, nativeTool: string): BashSteerBlock {
  const reason = `bash steer: \`${firstToken}\` was blocked before executing — use the native \`${nativeTool}\` tool instead of shelling out. ${BENEFITS[nativeTool]}. Re-issue this as a \`${nativeTool}\` tool call. Ordinary shell commands (builds, tests, git, pipelines) are never blocked. (Opt out: MINIMA_TUI_STEER=0.)`;
  return { block: true, nativeTool, reason };
}

export function bashSteerDecision(command: string): BashSteerBlock | null {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return null;
  for (const meta of METACHARS) {
    if (trimmed.includes(meta)) return null;
  }
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0]!;
  if (first.includes("=") || first.includes("/")) return null;
  const rest = tokens.slice(1);
  const nonFlagArgs = rest.filter((t) => !t.startsWith("-"));
  switch (first) {
    case "grep":
      return nonFlagArgs.length >= 2 ? block(first, "grep") : null;
    case "cat":
      return nonFlagArgs.length === 1 ? block(first, "read") : null;
    case "head":
    case "tail": {
      if (rest.includes("-f") || rest.includes("--follow")) return null;
      return nonFlagArgs.length >= 1 ? block(first, "read") : null;
    }
    case "find": {
      const flags = rest.filter((t) => t.startsWith("-"));
      return flags.every((f) => FIND_SAFE_FLAGS.has(f)) ? block(first, "glob") : null;
    }
    case "sed": {
      const inPlace = rest.some((t) => t === "--in-place" || t.startsWith("-i"));
      return inPlace ? block(first, "edit") : null;
    }
    default:
      return null;
  }
}

export function makeBashSteerHook(cfg: HarnessConfig): BeforeToolCall {
  return async (ctx) => {
    if (cfg.steer !== true) return null;
    if (ctx.toolCall.name !== "bash") return null;
    const command = ctx.args.command;
    if (typeof command !== "string") return null;
    const decision = bashSteerDecision(command);
    return decision ? { block: true, reason: decision.reason } : null;
  };
}
