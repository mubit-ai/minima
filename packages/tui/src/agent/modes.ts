/**
 * Primary-agent permission modes (B2 MUB-135, extended to the Claude Code-style ring) —
 * consumers of the Phase-0 PolicyBundle grammar:
 *
 *   build       — default: catch-all allow → normal permission flow (prompts per grants)
 *   acceptEdits — write/edit/apply_patch pre-approved (auto); bash keeps the normal flow.
 *                 The auto is cwd-SCOPED at the dispatcher (permissions.ts:
 *                 editTargetsWithinCwd) — an edit targeting a file outside the project
 *                 dir falls back to the normal prompt flow, Claude Code behavior.
 *   plan        — every mutating tool is DENIED at the dispatcher (Claude Code parity,
 *                 2026-07-20): the model is steered to the exit_plan approval instead of
 *                 the user being prompted per call. The bundle mirrors that as `deny`
 *                 (defense-in-depth for any non-TUI consumer); the TUI's layer-1 block in
 *                 app.tsx fires first with the richer planModeBlockReason copy.
 *   bypass      — everything pre-approved. A permanent member of the Shift+Tab ring
 *                 (MUB-177 R2 user decision); never persisted across sessions, so every
 *                 session still boots into a non-bypass mode.
 *
 * The mode lives in a module-level external store (same pattern as tui/badge_slot.ts) so
 * the beforeToolCall closure, the footer, /plan, and the Shift+Tab handler all read one
 * source of truth — inside or outside React.
 */

import type { PolicyBundle } from "./policy.ts";

export type AgentMode = "build" | "acceptEdits" | "plan" | "bypass";

export const BUILD_BUNDLE: PolicyBundle = {
  name: "build",
  rules: [{ tool: "*", pattern: "*", action: "allow" }],
};

export const ACCEPT_EDITS_BUNDLE: PolicyBundle = {
  name: "accept-edits",
  rules: [
    { tool: "*", pattern: "*", action: "allow" }, // catch-all first: last-match-wins
    { tool: "write", pattern: "*", action: "auto" },
    { tool: "edit", pattern: "*", action: "auto" },
    { tool: "apply_patch", pattern: "*", action: "auto" },
  ],
};

export const PLAN_BUNDLE: PolicyBundle = {
  name: "plan",
  rules: [
    { tool: "*", pattern: "*", action: "allow" }, // reads/grep/glob/ls/question — catch-all first
    { tool: "write", pattern: "*", action: "deny" }, // specifics after: last-match-wins
    { tool: "edit", pattern: "*", action: "deny" },
    { tool: "apply_patch", pattern: "*", action: "deny" },
    { tool: "bash", pattern: "*", action: "deny" },
  ],
};

export const BYPASS_BUNDLE: PolicyBundle = {
  name: "bypass",
  rules: [{ tool: "*", pattern: "*", action: "auto" }],
};

export function bundleForMode(mode: AgentMode): PolicyBundle {
  switch (mode) {
    case "acceptEdits":
      return ACCEPT_EDITS_BUNDLE;
    case "plan":
      return PLAN_BUNDLE;
    case "bypass":
      return BYPASS_BUNDLE;
    default:
      return BUILD_BUNDLE;
  }
}

/** Footer badge per mode (shared badge slot); build shows nothing. */
export const MODE_BADGES: Record<AgentMode, { text: string; color: string } | null> = {
  build: null,
  acceptEdits: { text: "⏵⏵ ACCEPT EDITS", color: "green" },
  plan: { text: "PLAN", color: "magenta" },
  bypass: { text: "⚠ BYPASS", color: "red" },
};

// ---------------------------------------------------------------- mode store
let currentMode: AgentMode = "build";
const subscribers = new Set<() => void>();

export function getMode(): AgentMode {
  return currentMode;
}

export function setMode(next: AgentMode): void {
  if (next === currentMode) return;
  currentMode = next;
  for (const fn of subscribers) fn();
}

const RING: AgentMode[] = ["build", "acceptEdits", "plan", "bypass"];

/** build → acceptEdits → plan → bypass → build. Bound to Shift+Tab. */
export function cycleMode(): AgentMode {
  const idx = RING.indexOf(currentMode);
  setMode(RING[(idx + 1) % RING.length] ?? "build");
  return currentMode;
}

export function subscribeMode(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------- prompt hint (B2.3)
/** Advisory escape hatch — exact sentence asserted by the prompt snapshot test. */
export const PLAN_ESCAPE_HATCH =
  "if you could describe the whole diff in one sentence, skip the plan and propose the change directly";

/** Mode-conditional system-prompt append. "" for build — headless runs stay unchanged. */
export function modeSystemAppend(mode: AgentMode): string {
  if (mode !== "plan") return "";
  return `\n\n# Plan mode\nYou are in plan mode: read and design first — write/edit/bash/apply_patch are BLOCKED until the plan is approved. Draft a short plan instead of making changes. When the plan is ready or the user asks to proceed, call the \`exit_plan\` tool with the complete plan (markdown) in its \`plan\` argument — the user will approve (optionally auto-accepting your edits), request revisions, or cancel. The planning itself is advisory: ${PLAN_ESCAPE_HATCH}.`;
}
