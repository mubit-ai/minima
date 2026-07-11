/**
 * Permission system for tool calls.
 *
 * - read/ls: Prompts the FIRST TIME a directory is accessed. Once approved
 *   ("always for this dir"), all future reads within that directory tree
 *   are silent. The cwd is NOT pre-approved — the user must grant access
 *   explicitly on first use in each new directory.
 * - write/edit/bash: Always prompts unless the user chose "always allow"
 *   for that specific tool.
 *
 * The TUI wires a BeforeToolCall hook that calls checkPermission(), which
 * returns null (allow) or { block, reason } (deny). Interactive prompts are
 * surfaced via a callback the React layer registers.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { expand } from "../tools/_io.ts";

// Read-only tools: gated by a first-use, directory-scoped prompt (see checkPermission). glob/grep
// scan the filesystem read-only just like read/ls, so they belong here (and the PermissionOverlay
// already labels them "READ").
const READ_TOOLS = new Set(["read", "ls", "glob", "grep"]);
// Tools that never need approval: pure UI interaction with zero side effects. Asking the user a
// question is not an action to gate — it *is* the user interaction.
const NO_PROMPT_TOOLS = new Set(["question"]);

export type PermissionDecision = "allow" | "always" | "deny";

/**
 * Tools the plan-mode beforeToolCall hook blocks at the LEAD's dispatcher (enforcement in
 * the dispatcher, never prompt text). groundTruth=false is the HISTORICAL list — the
 * default path must not change. groundTruth=true additionally blocks todowrite (approving
 * one authorizes running each task's `verify` as a shell command) and task (delegated
 * children are built hook-free with their own unrestricted toolset, so a task call is a
 * write-access bypass; the plan council's researchers delegate read-only WITHOUT the task
 * tool, so read-only research delegation stays available).
 */
export function planModeBlockedTools(groundTruth: boolean): string[] {
  return groundTruth
    ? ["write", "edit", "bash", "apply_patch", "todowrite", "task"]
    : ["write", "edit", "bash", "apply_patch"];
}

/** The block reason handed back to the model for a plan-mode-blocked tool call. */
export function planModeBlockReason(toolName: string, groundTruth: boolean): string {
  if (!groundTruth) {
    return "Plan mode is ON — write/edit/bash/apply_patch are blocked. Use /plan to exit.";
  }
  if (toolName === "task") {
    return (
      "Plan mode is ON — task is blocked: delegated children get their own unrestricted " +
      "toolset (write/edit/bash), while the plan council already provides read-only " +
      "research delegation. Use /plan to exit."
    );
  }
  return (
    "Plan mode is ON — write/edit/bash/apply_patch/todowrite/task are blocked " +
    "(todowrite can run `verify` shell checks). Use /plan to exit."
  );
}

export interface PermissionPrompt {
  toolName: string;
  argsSummary: string;
  promptText: string;
  diffPreview?: string | null;
  resolve: (decision: PermissionDecision) => void;
}

export interface PermissionState {
  allowAlways: Set<string>;
  allowedDirs: Set<string>;
  cwd: string;
  /** Ground-truth mode: todowrite `verify` commands are actually executed by the harness. */
  groundTruth: boolean;
  /** verify commands the user has already seen and approved (exact-string). */
  approvedVerifies: Set<string>;
}

export function createPermissionState(
  cwd: string,
  opts: { groundTruth?: boolean } = {},
): PermissionState {
  return {
    allowAlways: new Set<string>(),
    allowedDirs: new Set<string>(), // NOT pre-approved — user must grant cwd access
    cwd,
    groundTruth: opts.groundTruth === true,
    approvedVerifies: new Set<string>(),
  };
}

function extractPath(args: Record<string, unknown>): string | null {
  return (args.path ?? args.file_path ?? args.file ?? ".") as string;
}

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isWithin(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return String(args.command ?? "");
  if (toolName === "read" || toolName === "ls") return String(args.path ?? args.file_path ?? ".");
  if (toolName === "glob" || toolName === "grep") {
    const p = String(args.path ?? ".");
    return `${String(args.pattern ?? "")}${p && p !== "." ? ` in ${p}` : ""}`;
  }
  if (toolName === "write") return String(args.path ?? args.file_path ?? "?");
  if (toolName === "edit") return String(args.filePath ?? args.path ?? "?");
  if (toolName === "todowrite") {
    const tasks = parseTodowriteTasks(args);
    if (tasks) {
      const withVerify = tasks.filter((t) => t.verify).length;
      return `${tasks.length} task${tasks.length === 1 ? "" : "s"}${
        withVerify > 0 ? ` (${withVerify} with a verify shell command)` : ""
      }`;
    }
  }
  return JSON.stringify(args).slice(0, 120);
}

/** Best-effort parse of todowrite's `tasks` JSON-string arg (null when malformed). */
function parseTodowriteTasks(
  args: Record<string, unknown>,
): { content: string; status: string; verify: string | null }[] | null {
  try {
    const parsed = JSON.parse(String(args.tasks));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((t) => ({
      content: String(t?.content ?? ""),
      status: String(t?.status ?? "pending"),
      verify: typeof t?.verify === "string" && t.verify.trim() ? t.verify.trim() : null,
    }));
  } catch {
    return null;
  }
}

/**
 * Message handed back to the model when the USER declines a tool call. Framed to stop the
 * "sandbox spiral" (notably Gemini): a decline is a user choice, not an environment or
 * sandbox restriction, so the model should try a different action — not retry the identical
 * call, escalate, or abandon the task believing its tools are broken. `subject` names what
 * was declined, e.g. "the bash call" or "read access to /repo/src".
 */
export function denialReason(subject: string): string {
  return `The user declined ${subject} — this is a user choice, not an environment restriction or sandbox limit. Do not retry the call and do not attempt the same action through other tools; continue without it or ask the user how to proceed.`;
}

/**
 * One-line label for the live "current action" indicator: tool name + a compact arg
 * summary (`bash: git diff --stat`). `args` is null when the model named an unknown tool
 * or its params failed validation — fall back to the bare tool name.
 */
export function formatActionLabel(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const summary = formatToolArgs(toolName, args as Record<string, unknown>);
    return summary ? `${toolName}: ${summary}` : toolName;
  }
  return toolName;
}

export type PromptFn = (prompt: PermissionPrompt) => void;

export function checkPermission(
  toolName: string,
  args: Record<string, unknown>,
  state: PermissionState,
  promptFn: PromptFn,
): Promise<{ block: boolean; reason: string } | null> {
  // Zero-side-effect UI tools (e.g. question): never prompt.
  if (NO_PROMPT_TOOLS.has(toolName)) return Promise.resolve(null);

  // Tool globally allowed (write/edit/bash with "always"). Exception: with ground truth on,
  // approving a todowrite authorizes the harness to EXECUTE each task's `verify` as a shell
  // command (baseline capture + done-gate), so a stored "always" only covers verify commands
  // the user has already seen — a call carrying a new or changed verify re-prompts.
  if (state.allowAlways.has(toolName)) {
    const newVerify =
      toolName === "todowrite" &&
      state.groundTruth &&
      verifyCommands(args).some((v) => !state.approvedVerifies.has(v));
    if (!newVerify) return Promise.resolve(null);
  }

  // For read-only tools (read/ls/glob/grep): check directory-level access
  if (READ_TOOLS.has(toolName)) {
    const rawPath = extractPath(args);
    if (!rawPath) return Promise.resolve(null);

    const fullPath = resolvePath(rawPath, state.cwd);
    // Check if within any already-approved directory
    for (const dir of state.allowedDirs) {
      if (isWithin(fullPath, dir)) return Promise.resolve(null);
    }

    // Determine the directory to ask about: `read` targets a file, so ask about its parent dir;
    // ls/glob/grep target a directory (their `path` arg), so ask about it directly.
    const targetDir = toolName === "read" ? dirname(fullPath) : fullPath;

    return new Promise((resolve) => {
      promptFn({
        toolName,
        argsSummary: formatToolArgs(toolName, args),
        promptText: `read from ${targetDir}`,
        resolve: (decision) => {
          if (decision === "always") {
            state.allowedDirs.add(targetDir);
          }
          if (decision === "allow" || decision === "always") {
            resolve(null);
          } else {
            resolve({ block: true, reason: denialReason(`read access to ${targetDir}`) });
          }
        },
      });
    });
  }

  // Sensitive tools (write/edit/bash): always prompt
  const diffPreview = buildDiffPreview(toolName, args, state);
  return new Promise((resolve) => {
    promptFn({
      toolName,
      argsSummary: formatToolArgs(toolName, args),
      promptText: `run ${toolName}`,
      diffPreview,
      resolve: (decision) => {
        if (decision === "always") state.allowAlways.add(toolName);
        if (decision === "allow" || decision === "always") {
          // The user has now seen these verify commands — an "always" grant covers them,
          // but any future NEW verify still re-prompts (see the allowAlways exception above).
          if (toolName === "todowrite") {
            for (const v of verifyCommands(args)) state.approvedVerifies.add(v);
          }
          resolve(null);
        } else {
          resolve({ block: true, reason: denialReason(`the ${toolName} call`) });
        }
      },
    });
  });
}

/** Every non-empty `verify` shell command in a todowrite call's tasks. */
function verifyCommands(args: Record<string, unknown>): string[] {
  const tasks = parseTodowriteTasks(args);
  if (!tasks) return [];
  return tasks.map((t) => t.verify).filter((v): v is string => typeof v === "string" && v !== "");
}

function buildDiffPreview(
  toolName: string,
  args: Record<string, unknown>,
  state: PermissionState,
): string | null {
  const cwd = state.cwd;
  try {
    if (toolName === "edit") {
      const filePath = expand(String(args.filePath ?? args.path ?? ""));
      const full = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const _existing = existsSync(full) ? readFileSync(full, "utf8") : "";
      const oldLines = oldStr.split("\n");
      const newLines = newStr.split("\n");
      const max = Math.max(oldLines.length, newLines.length, 8);
      const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
      for (let i = 0; i < max; i++) {
        if (i < oldLines.length && oldLines[i] !== newLines[i]) {
          lines.push(`- ${oldLines[i] ?? ""}`);
        }
        if (i < newLines.length && oldLines[i] !== newLines[i]) {
          lines.push(`+ ${newLines[i] ?? ""}`);
        }
        if (i >= oldLines.length && i >= newLines.length) break;
      }
      return lines.join("\n");
    }
    if (toolName === "write") {
      const filePath = expand(String(args.path ?? args.file_path ?? ""));
      const content = String(args.content ?? "");
      const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      if (!existing) return `(new file: ${filePath}, ${content.split("\n").length} lines)`;
      const preview = content.split("\n").slice(0, 8).join("\n");
      return `--- ${filePath} (old)\n+++ ${filePath} (new, first 8 lines)\n${preview}`;
    }
    if (toolName === "todowrite") {
      // With ground truth on, approving a todowrite authorizes running each task's `verify`
      // as a shell command (done-gate + baseline capture) — the user must SEE those commands,
      // not a truncated JSON blob, before granting that.
      const tasks = parseTodowriteTasks(args);
      if (!tasks || tasks.length === 0) return null;
      const lines = tasks.map((t, i) => {
        const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
        const verifyLabel = state.groundTruth
          ? "verify (runs as a shell command)"
          : "verify (recorded only — runs only with MINIMA_TUI_GROUND_TRUTH=1)";
        const verify = t.verify ? `\n     ${verifyLabel}: ${t.verify}` : "";
        return `${i + 1}. [${mark}] ${t.content}${verify}`;
      });
      return lines.join("\n");
    }
  } catch {
    // diff preview is best-effort
  }
  return null;
}
