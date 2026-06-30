/**
 * System prompt assembly — port of minima_harness/tui/context.py.
 *
 * Builds the system prompt from: BASE_SYSTEM + AGENTS.md/CLAUDE.md project context
 * + SYSTEM.md (replace) / APPEND_SYSTEM.md (append) overrides.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const GLOBAL_DIR = resolve(homedir(), ".minima-harness");
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];

const BASE_SYSTEM =
  "You are an interactive coding agent running in the user's terminal. Use the provided " +
  "tools (read, write, edit, bash, grep, glob, ls, web_fetch) to explore and modify the " +
  "codebase and look up documentation online. Be concise and direct; explain only when asked.";

const SUMMARY_SYSTEM =
  "You compact a coding-agent conversation. Summarize the work done so far: key decisions, " +
  "file paths touched, current state, and open questions. Be concise. Output only the summary.";

function tryRead(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

function loadAgentsMd(cwd: string): string {
  const chunks: string[] = [];

  for (const name of CONTEXT_FILES) {
    const g = tryRead(resolve(GLOBAL_DIR, name));
    if (g) chunks.push(`# (${name}, global)\n${g}`);
  }

  const parts: string[] = [];
  let node = resolve(cwd);
  for (;;) {
    parts.push(node);
    const parent = resolve(node, "..");
    if (parent === node) break;
    node = parent;
  }
  for (const d of [...parts].reverse()) {
    for (const name of CONTEXT_FILES) {
      const t = tryRead(resolve(d, name));
      if (t) chunks.push(`# (${name}, ${d.split("/").pop()})\n${t}`);
    }
  }
  return chunks.join("\n\n");
}

export function buildSystemPrompt(cwd: string): string {
  const replace = tryRead(resolve(cwd, "SYSTEM.md")) ?? tryRead(resolve(GLOBAL_DIR, "SYSTEM.md"));
  const append =
    tryRead(resolve(cwd, "APPEND_SYSTEM.md")) ?? tryRead(resolve(GLOBAL_DIR, "APPEND_SYSTEM.md"));

  let base = replace ?? BASE_SYSTEM;
  if (append) base = `${base}\n\n${append}`;

  const agents = loadAgentsMd(cwd);
  if (agents) return `${base}\n\n# Project context\n${agents}`;
  return base;
}

export { SUMMARY_SYSTEM, BASE_SYSTEM };
