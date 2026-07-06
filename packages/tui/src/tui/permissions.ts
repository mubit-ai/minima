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
}

export function createPermissionState(cwd: string): PermissionState {
  return {
    allowAlways: new Set<string>(),
    allowedDirs: new Set<string>(), // NOT pre-approved — user must grant cwd access
    cwd,
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
  return JSON.stringify(args).slice(0, 120);
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

export type PromptFn = (prompt: PermissionPrompt) => void;

export function checkPermission(
  toolName: string,
  args: Record<string, unknown>,
  state: PermissionState,
  promptFn: PromptFn,
): Promise<{ block: boolean; reason: string } | null> {
  // Zero-side-effect UI tools (e.g. question): never prompt.
  if (NO_PROMPT_TOOLS.has(toolName)) return Promise.resolve(null);

  // Tool globally allowed (write/edit/bash with "always")
  if (state.allowAlways.has(toolName)) return Promise.resolve(null);

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
  const diffPreview = buildDiffPreview(toolName, args, state.cwd);
  return new Promise((resolve) => {
    promptFn({
      toolName,
      argsSummary: formatToolArgs(toolName, args),
      promptText: `run ${toolName}`,
      diffPreview,
      resolve: (decision) => {
        if (decision === "always") state.allowAlways.add(toolName);
        if (decision === "allow" || decision === "always") {
          resolve(null);
        } else {
          resolve({ block: true, reason: denialReason(`the ${toolName} call`) });
        }
      },
    });
  });
}

function buildDiffPreview(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | null {
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
  } catch {
    // diff preview is best-effort
  }
  return null;
}
