/**
 * System prompt assembly — port of the Python harness's tui/context.py.
 *
 * Builds the system prompt from: BASE_SYSTEM + AGENTS.md/CLAUDE.md project context
 * + SYSTEM.md (replace) / APPEND_SYSTEM.md (append) overrides.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const GLOBAL_DIR = resolve(homedir(), ".minima-harness");
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];

// The tools sentence is resolved at call time (not module load): EXA_API_KEY may be
// hydrated from the config store after import, and the web tools only register when
// it is set — the prompt must not advertise tools the agent doesn't have.
const baseSystem = () => [
  "You are an expert coding agent in the user's terminal. You have tools to read, write,",
  `edit, search (grep/glob), and run commands (bash)${
    process.env.EXA_API_KEY ? ", plus web_search/web_fetch for live web access" : ""
  }.`,
  "",
  "Rules:",
  "- ALWAYS read a file before editing it. Never guess file contents.",
  "- Prefer edit (targeted changes) over write (full rewrite). Never rewrite an entire",
  "  file when a small edit suffices.",
  "- After making changes, run the relevant tests, linter, or build command to verify.",
  "  Show the result. Do not claim success without evidence.",
  "- Batch independent tool calls in one response for speed.",
  "- Match existing code conventions, imports, and patterns. Don't introduce new",
  "  dependencies without reason.",
  "- Answer the user's actual request and nothing more. Do NOT proactively run tools (ls, read,",
  "  bash, etc.) or explore the project unless the request needs it — a greeting or a plain",
  "  question needs no tool calls.",
  "- If a request is ambiguous, ask for clarification rather than guessing.",
  "- Don't leave TODO comments or placeholder code. Fully implement what's asked.",
  "- Don't modify unrelated code. Change only what's needed.",
  "- Be concise. No preamble, no apology, no unnecessary explanation.",
];

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

  let base = replace ?? baseSystem().join("\n");
  if (append) base = `${base}\n\n${append}`;

  const agents = loadAgentsMd(cwd);
  if (agents) return `${base}\n\n# Project context\n${agents}`;
  return base;
}

export { SUMMARY_SYSTEM, baseSystem };
