/**
 * Permission system for tool calls.
 *
 * - read/ls: Prompts the FIRST TIME a directory is accessed. Once approved
 *   ("always for this dir"), all future reads within that directory tree
 *   are silent. The cwd is NOT pre-approved — the user must grant access
 *   explicitly on first use in each new directory.
 * - write/edit/bash: Always prompts unless the user chose "always allow". For bash the
 *   "always" is a per-command-family grant ("Always allow `pip` commands"), persisted per
 *   project (perm_grants.ts); other tools keep the whole-tool, session-only grant.
 *
 * The TUI wires a BeforeToolCall hook that calls checkPermission(), which
 * returns null (allow) or { block, reason } (deny). Interactive prompts are
 * surfaced via a callback the React layer registers.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type AgentMode, bundleForMode, enableBypass } from "../agent/modes.ts";
import { type PolicyBundle, emitGuardEvent, resolvePolicy } from "../agent/policy.ts";
import type { BeforeToolCallContext, BeforeToolCallResult } from "../agent/tools.ts";
import { expand } from "../tools/_io.ts";
import { parsePatch } from "../tools/apply_patch.ts";
import { loadBashGrants, persistBashGrants } from "./perm_grants.ts";

// Read-only tools: gated by a first-use, directory-scoped prompt (see checkPermission). glob/grep
// scan the filesystem read-only just like read/ls, so they belong here (and the PermissionOverlay
// already labels them "READ").
const READ_TOOLS = new Set(["read", "ls", "glob", "grep"]);
// Tools that never need approval: pure UI interaction with zero side effects. Asking the user a
// question is not an action to gate — it *is* the user interaction. exit_plan's approval overlay
// is likewise the interaction itself.
const NO_PROMPT_TOOLS = new Set(["question", "exit_plan"]);

export type PermissionDecision = "allow" | "always" | "deny";

/**
 * Tools the plan-mode beforeToolCall hook blocks at the LEAD's dispatcher (enforcement in
 * the dispatcher, never prompt text). bigPlan=false is the HISTORICAL list — the
 * default path must not change. bigPlan=true additionally blocks todowrite (approving
 * one authorizes running each task's `verify` as a shell command) and task (delegated
 * children are built hook-free with their own unrestricted toolset, so a task call is a
 * write-access bypass; the plan council's researchers delegate read-only WITHOUT the task
 * tool, so read-only research delegation stays available).
 */
export function planModeBlockedTools(bigPlan: boolean): string[] {
  // `task` is blocked in BOTH modes: a delegated child gets its own unrestricted toolset
  // (write/edit/bash) with no permission hooks, so plan mode's read-only promise was
  // trivially bypassable by delegating the write.
  return bigPlan
    ? ["write", "edit", "bash", "apply_patch", "todowrite", "task"]
    : ["write", "edit", "bash", "apply_patch", "task"];
}

/** The block reason handed back to the model for a plan-mode-blocked tool call. */
export function planModeBlockReason(toolName: string, bigPlan: boolean): string {
  if (!bigPlan) {
    return toolName === "task"
      ? "Plan mode is ON — task is blocked: delegated children get their own unrestricted toolset (write/edit/bash). When the user asks to proceed with the plan, call the exit_plan tool to request approval to exit plan mode; otherwise continue planning."
      : "Plan mode is ON — write/edit/bash/apply_patch are blocked. When the user asks to proceed with the plan, call the exit_plan tool to request approval to exit plan mode; otherwise continue planning.";
  }
  if (toolName === "task") {
    return (
      "Plan mode is ON — task is blocked: delegated children get their own unrestricted " +
      "toolset (write/edit/bash), while the plan council already provides read-only " +
      "research delegation. When the user asks to proceed with the plan, call the exit_plan " +
      "tool to request approval to finalize and exit plan mode; otherwise continue planning."
    );
  }
  return (
    "Plan mode is ON — write/edit/bash/apply_patch/todowrite/task are blocked " +
    "(todowrite can run `verify` shell checks). When the user asks to proceed with the plan, " +
    "call the exit_plan tool to request approval to finalize and exit plan mode; otherwise " +
    "continue planning."
  );
}

/**
 * R3b: a HARNESS-authored guard denial — the plan-mode dispatcher block above or the mode
 * policy deny (makeModeGatedBeforeToolCall below); both producers live in this module and own
 * these stable prefixes. The transcript renders a match as a calm dim one-liner: the guard
 * working as designed, not a failure. A USER decline (denialReason) deliberately does NOT
 * match — a user choice stays a real denial. The full text always reaches the model.
 */
export function isGuardDenyReason(text: string): boolean {
  return (
    text.startsWith("Plan mode is ON —") ||
    /^The \S+ call is denied by the \S+ mode policy/.test(text)
  );
}

export interface PermissionPrompt {
  toolName: string;
  argsSummary: string;
  promptText: string;
  diffPreview?: string | null;
  /** The pending call's raw args — lets a Shift+Tab mode cycle re-evaluate the call
   *  (cwd-scoped accept-edits auto needs the real target paths, not the display summary). */
  args?: Record<string, unknown>;
  /** Overlay label for the "[a]" option — bash offers a per-command-family grant
   *  ("Always allow `pip` commands") instead of the whole-tool default. */
  alwaysLabel?: string;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * The command "families" a bash call runs: the leading word of each segment of a compound
 * command (`pip install -e . && git add .` → ["pip", "git"]), env-var prefixes skipped,
 * paths reduced to their basename. Drives the persisted per-command grants — a stored grant
 * silently allows a call only when EVERY segment's family is granted. Returns null (no grant
 * offered, no grant matched) for commands we won't analyze: command substitution can smuggle
 * arbitrary execution under a granted family. Splitting is deliberately naive — a separator
 * hidden inside quotes over-splits into garbage families that simply won't match a grant, so
 * the failure direction is a prompt, never a silent allow.
 */
export function bashCommandFamilies(cmd: string): string[] | null {
  if (/\$\(|`|<\(/.test(cmd)) return null;
  const families: string[] = [];
  for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue; // empty segment (trailing `;`/`&&`) runs nothing
    const head = tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!head) return null; // bare env assignment — don't analyze
    const family = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
    if (!family) return null;
    if (!families.includes(family)) families.push(family);
  }
  return families.length > 0 ? families : null;
}

/** write/edit/apply_patch — the tools whose accept-edits `auto` is cwd-scoped. */
const EDIT_FAMILY = new Set(["write", "edit", "apply_patch"]);

/**
 * True when EVERY file the call would touch resolves inside `cwd` (Claude Code parity:
 * accept-edits auto-approves workspace edits only — an edit escaping the project dir keeps
 * the normal prompt flow). write/edit contribute their single target; apply_patch parses
 * its patch for every Add/Update/Delete path AND Move-to destination; a malformed patch or
 * a missing path never auto-approves. Non-edit tools have no path targets to scope — true.
 */
export function editTargetsWithinCwd(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): boolean {
  if (!EDIT_FAMILY.has(toolName)) return true;
  const targets: string[] = [];
  if (toolName === "write") {
    targets.push(String(args.path ?? args.file_path ?? ""));
  } else if (toolName === "edit") {
    targets.push(String(args.filePath ?? args.path ?? ""));
  } else {
    try {
      for (const change of parsePatch(String(args.patch ?? ""))) {
        targets.push(change.path);
        if (change.moveTo) targets.push(change.moveTo);
      }
    } catch {
      return false;
    }
    if (targets.length === 0) return false;
  }
  return targets.every((t) => {
    if (!t.trim()) return false;
    const full = expand(t);
    return isWithin(isAbsolute(full) ? full : resolve(cwd, full), cwd);
  });
}

export interface PermissionState {
  allowAlways: Set<string>;
  /** Persisted per-project bash command-family grants ("pip", "git", …). */
  bashGrants: Set<string>;
  allowedDirs: Set<string>;
  cwd: string;
  /** Plan verification mode: todowrite `verify` commands are actually executed by the harness. */
  bigPlan: boolean;
  /** verify commands the user has already seen and approved (exact-string). */
  approvedVerifies: Set<string>;
  /** ui-modes-style project key; when set, new bash grants persist across sessions. */
  projectKey: string | null;
}

export function createPermissionState(
  cwd: string,
  opts: { bigPlan?: boolean; projectKey?: string } = {},
): PermissionState {
  const projectKey = opts.projectKey ?? null;
  return {
    allowAlways: new Set<string>(),
    bashGrants: new Set<string>(projectKey ? loadBashGrants(projectKey) : []),
    allowedDirs: new Set<string>(), // NOT pre-approved — user must grant cwd access
    cwd,
    bigPlan: opts.bigPlan === true,
    approvedVerifies: new Set<string>(),
    projectKey,
  };
}

/**
 * "Finalize & auto-accept edits" landing (MUB-179): approving a plan with auto-accept is
 * consent to work the project — in-cwd reads run silent (out-of-cwd reads still prompt)
 * and bypass joins the Shift+Tab ring for the rest of the process. The mode is NOT
 * switched to bypass, and bypass stays never-persisted (mode_prefs.ts).
 */
export function finalizeAutoAcceptLanding(state: PermissionState): void {
  state.allowedDirs.add(state.cwd);
  enableBypass();
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

export interface CheckPermissionOpts {
  /**
   * Plan-mode "ask" (B2): skip the no-prompt / allowAlways / allowed-dir short-circuits and
   * go straight to the interactive prompt. An "always" answer still records the grant (it
   * pays off in build mode), but the mode rule keeps outranking it — the next forced call
   * prompts again.
   */
  forcePrompt?: boolean;
  /** Prefix for the overlay's prompt text, e.g. "plan mode — asks every time: ". */
  promptTextPrefix?: string;
}

export function checkPermission(
  toolName: string,
  args: Record<string, unknown>,
  state: PermissionState,
  promptFn: PromptFn,
  opts: CheckPermissionOpts = {},
): Promise<{ block: boolean; reason: string } | null> {
  if (!opts.forcePrompt) {
    // Zero-side-effect UI tools (e.g. question): never prompt.
    if (NO_PROMPT_TOOLS.has(toolName)) return Promise.resolve(null);

    // Tool globally allowed (write/edit/bash with "always"). Exception: with plan verification on,
    // approving a todowrite authorizes the harness to EXECUTE each task's `verify` as a shell
    // command (baseline capture + done-gate), so a stored "always" only covers verify commands
    // the user has already seen — a call carrying a new or changed verify re-prompts.
    // Second exception (MUB-178): edit-family grants are cwd-scoped — an out-of-cwd target
    // re-prompts in EVERY mode (the grant stays valid for in-cwd targets), so a session
    // "Always write" can never defeat accept-edits' cwd fallback by short-circuit ordering.
    if (state.allowAlways.has(toolName)) {
      const newVerify =
        toolName === "todowrite" &&
        state.bigPlan &&
        verifyCommands(args).some((v) => !state.approvedVerifies.has(v));
      const outsideCwd =
        EDIT_FAMILY.has(toolName) && !editTargetsWithinCwd(toolName, args, state.cwd);
      if (!newVerify && !outsideCwd) return Promise.resolve(null);
    }

    // Persisted per-command grants (bash only): silent when every segment family was
    // granted before. Unanalyzable commands (null) never match — they keep the prompt.
    if (toolName === "bash" && state.bashGrants.size > 0) {
      const families = bashCommandFamilies(String(args.command ?? ""));
      if (families?.every((f) => state.bashGrants.has(f))) return Promise.resolve(null);
    }
  }

  // For read-only tools (read/ls/glob/grep): check directory-level access
  if (!opts.forcePrompt && READ_TOOLS.has(toolName)) {
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
        args,
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

  // Sensitive tools (write/edit/bash) — or any forced prompt (plan-mode "ask"): always prompt
  const diffPreview = buildDiffPreview(toolName, args, state);
  // Bash "always" is a per-command-family grant (persisted per project) when the command is
  // analyzable; anything else keeps the whole-tool session grant.
  const bashFamilies = toolName === "bash" ? bashCommandFamilies(String(args.command ?? "")) : null;
  return new Promise((resolve) => {
    promptFn({
      toolName,
      argsSummary: formatToolArgs(toolName, args),
      promptText: `${opts.promptTextPrefix ?? ""}run ${toolName}`,
      diffPreview,
      args,
      alwaysLabel: bashFamilies
        ? `Always allow ${bashFamilies.map((f) => `\`${f}\``).join(", ")} commands`
        : undefined,
      resolve: (decision) => {
        if (decision === "always") {
          if (bashFamilies) {
            for (const f of bashFamilies) state.bashGrants.add(f);
            if (state.projectKey) persistBashGrants(state.projectKey, bashFamilies);
          } else {
            state.allowAlways.add(toolName);
          }
        }
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

/**
 * Would `mode`'s policy run this tool call with NO prompt? Drives the Claude Code-parity
 * Shift+Tab-during-a-permission-prompt path: cycling into a mode whose bundle says "auto"
 * for the pending call (accept-edits → write/edit/apply_patch, bypass → everything)
 * resolves the on-screen prompt instead of leaving it stranded under the new mode.
 *
 * accept-edits auto is cwd-scoped: `editScope` carries the pending call's raw args + the
 * project cwd so the SAME editTargetsWithinCwd check the dispatcher applies decides here
 * too. Without args (a caller that can't supply them) the edit family fails SAFE — the
 * prompt stays up rather than auto-approving an unverifiable target.
 */
export function modeAutoApproves(
  mode: AgentMode,
  toolName: string,
  subject: string,
  editScope?: { args: Record<string, unknown> | null; cwd: string },
): boolean {
  if (resolvePolicy(bundleForMode(mode), { tool: toolName, subject }) !== "auto") return false;
  if (mode === "acceptEdits" && EDIT_FAMILY.has(toolName)) {
    if (!editScope?.args) return false;
    return editTargetsWithinCwd(toolName, editScope.args, editScope.cwd);
  }
  return true;
}

/**
 * The app's mode-gating beforeToolCall hook (B2): resolve the active mode's PolicyBundle
 * first, then fall through to the normal permission flow.
 *   deny  → GuardEvent(mode-deny) + block with a policy reason (fed back to the model)
 *   ask   → GuardEvent(mode-ask) + forced prompt (outranks "always" grants)
 *   auto  → GuardEvent(mode-auto) + run WITHOUT any prompt (accept-edits / bypass modes);
 *           accept-edits scopes the edit family to cwd — an outside-cwd target falls back
 *           to the normal prompt flow (Claude Code parity)
 *   allow → normal checkPermission flow (unchanged build-mode behavior)
 * `getBundle` is injected so tests can pin a bundle and the app can read the live mode.
 */
export function makeModeGatedBeforeToolCall(deps: {
  state: PermissionState;
  promptFn: PromptFn;
  getBundle: () => PolicyBundle;
}): (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | null> {
  return async (ctx) => {
    const toolName = ctx.toolCall.name;
    const bundle = deps.getBundle();
    const action = resolvePolicy(bundle, {
      tool: toolName,
      subject: formatToolArgs(toolName, ctx.args),
    });
    if (action === "deny") {
      emitGuardEvent({ kind: "mode-deny", detail: formatActionLabel(toolName, ctx.args) });
      return {
        block: true,
        reason: `The ${toolName} call is denied by the ${bundle.name} mode policy — a user setting, not an environment restriction. Continue without it or ask the user to switch modes.`,
      };
    }
    if (action === "ask") {
      emitGuardEvent({ kind: "mode-ask", detail: formatActionLabel(toolName, ctx.args) });
      return checkPermission(toolName, ctx.args, deps.state, deps.promptFn, {
        forcePrompt: true,
        promptTextPrefix: `${bundle.name} mode — asks every time: `,
      });
    }
    if (action === "auto") {
      if (
        bundle.name === "accept-edits" &&
        !editTargetsWithinCwd(toolName, ctx.args, deps.state.cwd)
      ) {
        return checkPermission(toolName, ctx.args, deps.state, deps.promptFn);
      }
      // Mode-pre-approved (accept-edits / bypass): run with no prompt; the guard event is
      // the audit trail for what the mode waved through.
      emitGuardEvent({ kind: "mode-auto", detail: formatActionLabel(toolName, ctx.args) });
      return null;
    }
    return checkPermission(toolName, ctx.args, deps.state, deps.promptFn);
  };
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
      // With plan verification on, approving a todowrite authorizes running each task's `verify`
      // as a shell command (done-gate + baseline capture) — the user must SEE those commands,
      // not a truncated JSON blob, before granting that.
      const tasks = parseTodowriteTasks(args);
      if (!tasks || tasks.length === 0) return null;
      const lines = tasks.map((t, i) => {
        const mark = t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
        const verifyLabel = state.bigPlan
          ? "verify (runs as a shell command)"
          : "verify (recorded only — plan verification is disabled via MINIMA_TUI_BIG_PLAN=0)";
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
