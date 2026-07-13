/**
 * Plan/Build primary-agent modes (B2, MUB-135) — the first consumer of the Phase-0
 * PolicyBundle grammar. Build is the default (catch-all allow → normal permission flow);
 * Plan turns every mutating tool into an "ask" (the permission overlay prompts even for
 * tools the user granted "always" — the mode rule outranks the session grant).
 *
 * The mode lives in a module-level external store (same pattern as tui/badge_slot.ts) so
 * the beforeToolCall closure, the footer, /plan, and the Shift+Tab handler all read one
 * source of truth — inside or outside React.
 */

import type { PolicyBundle } from "./policy.ts";

export type AgentMode = "build" | "plan";

export const BUILD_BUNDLE: PolicyBundle = {
  name: "build",
  rules: [{ tool: "*", pattern: "*", action: "allow" }],
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

export function bundleForMode(mode: AgentMode): PolicyBundle {
  return mode === "plan" ? PLAN_BUNDLE : BUILD_BUNDLE;
}

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

/** build ↔ plan; returns the new mode. Bound to Shift+Tab and /plan. */
export function cycleMode(): AgentMode {
  setMode(currentMode === "build" ? "plan" : "build");
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
  return (
    "\n\n# Plan mode\n" +
    "You are in plan mode: prefer reading and designing before mutating — write/edit/bash " +
    "will ask the user first. Draft a short plan before making changes. This is advisory, " +
    `not a hard rule: ${PLAN_ESCAPE_HATCH}.`
  );
}
