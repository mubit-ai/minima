/**
 * Primary-agent permission modes (B2 MUB-135, extended to the Claude Code-style ring) —
 * consumers of the Phase-0 PolicyBundle grammar:
 *
 *   build       — default: catch-all allow → normal permission flow (prompts per grants)
 *   acceptEdits — write/edit/apply_patch pre-approved (auto); bash keeps the normal flow
 *   plan        — every mutating tool is an "ask" that outranks session "always" grants
 *   bypass      — everything pre-approved. NOT in the Shift+Tab ring unless explicitly
 *                 enabled (--dangerously-bypass-permissions or /mode bypass); never
 *                 persisted across sessions.
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
    { tool: "write", pattern: "*", action: "ask" }, // specifics after: last-match-wins
    { tool: "edit", pattern: "*", action: "ask" },
    { tool: "apply_patch", pattern: "*", action: "ask" },
    { tool: "bash", pattern: "*", action: "ask" },
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
let bypassEnabled = false;
const subscribers = new Set<() => void>();

export function getMode(): AgentMode {
  return currentMode;
}

export function setMode(next: AgentMode): void {
  if (next === currentMode) return;
  currentMode = next;
  for (const fn of subscribers) fn();
}

/**
 * Opt bypass into the session (CLI flag or an explicit /mode bypass). One-way: it joins
 * the Shift+Tab ring for the rest of the process, but is never persisted.
 */
export function enableBypass(): void {
  bypassEnabled = true;
}

export function isBypassEnabled(): boolean {
  return bypassEnabled;
}

const RING: AgentMode[] = ["build", "acceptEdits", "plan"];

/** build → acceptEdits → plan (→ bypass when enabled) → build. Bound to Shift+Tab. */
export function cycleMode(): AgentMode {
  const ring = bypassEnabled ? [...RING, "bypass" as AgentMode] : RING;
  const idx = ring.indexOf(currentMode);
  setMode(ring[(idx + 1) % ring.length] ?? "build");
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
  return `\n\n# Plan mode\nYou are in plan mode: prefer reading and designing before mutating — write/edit/bash will ask the user first. Draft a short plan before making changes. This is advisory, not a hard rule: ${PLAN_ESCAPE_HATCH}.`;
}
