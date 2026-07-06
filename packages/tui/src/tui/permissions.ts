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

const READ_TOOLS = new Set(["read", "ls"]);

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
  if (toolName === "write") return String(args.path ?? args.file_path ?? "?");
  if (toolName === "edit") return String(args.filePath ?? args.path ?? "?");
  if (toolName === "grep" || toolName === "glob") return String(args.pattern ?? "");
  return JSON.stringify(args).slice(0, 120);
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
  // Tool globally allowed (write/edit/bash with "always")
  if (state.allowAlways.has(toolName)) return Promise.resolve(null);

  // For read/ls: check directory-level access
  if (READ_TOOLS.has(toolName)) {
    const rawPath = extractPath(args);
    if (!rawPath) return Promise.resolve(null);

    const fullPath = resolvePath(rawPath, state.cwd);
    // Check if within any already-approved directory
    for (const dir of state.allowedDirs) {
      if (isWithin(fullPath, dir)) return Promise.resolve(null);
    }

    // Determine the directory to ask about (the target dir itself for ls,
    // or the file's parent dir for read)
    const targetDir = toolName === "ls" ? fullPath : dirname(fullPath);

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
            resolve({ block: true, reason: `Permission denied: ${targetDir} not approved` });
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
          resolve({ block: true, reason: `Permission denied for ${toolName}` });
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
