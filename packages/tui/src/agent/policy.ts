/**
 * Phase-0 interface contract (docs/BigPlan/PLAN.md §3, MUB-129): the permission grammar and
 * guard-event type both Big-Plan tracks build on. Pure data + resolution — no enforcement
 * lives here. The beforeToolCall wiring lands in A6 (per-step allowlist) and B2 (Plan/Build
 * modes); guards emit in A2 (verify N-strike) and A3 (doom_loop / steps cap).
 *
 * Grammar (OpenCode semantics): rules are evaluated top-to-bottom against a tool call and
 * the LAST matching rule wins — write `*` catch-alls first, specifics after. A per-agent
 * bundle overrides a base bundle by appending its rules (later == stronger).
 */

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  /** Tool name this rule applies to; `*` matches every tool. */
  tool: string;
  /**
   * Glob over the call's subject — the bash command line, the edit/write path, the task
   * subagent name. `*` matches any run of characters (including none), `?` exactly one.
   */
  pattern: string;
  action: PolicyAction;
}

export interface PolicyBundle {
  /** Display name, e.g. "build", "plan", or "step:<id>". */
  name: string;
  rules: PolicyRule[];
}

/** Glob match: `*` = any run of characters (including none), `?` = exactly one. */
export function globMatch(pattern: string, value: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`).test(value);
}

export interface PolicyQuery {
  tool: string;
  /** What the rule patterns match against (command line / path / subagent name). */
  subject: string;
}

/**
 * Resolve a tool call against a bundle. Every rule whose `tool` matches is consulted in
 * order; the last one whose `pattern` matches the subject decides. No match → `fallback`.
 */
export function resolvePolicy(
  bundle: PolicyBundle,
  query: PolicyQuery,
  fallback: PolicyAction = "allow",
): PolicyAction {
  let action = fallback;
  for (const rule of bundle.rules) {
    if (rule.tool !== "*" && rule.tool !== query.tool) continue;
    if (globMatch(rule.pattern, query.subject)) action = rule.action;
  }
  return action;
}

/** Per-agent/per-step override: appended rules come later, so they win under last-match-wins. */
export function mergeBundles(
  name: string,
  base: PolicyBundle,
  override: PolicyBundle,
): PolicyBundle {
  return { name, rules: [...base.rules, ...override.rules] };
}

// ---------------------------------------------------------------------------- guard events

export type GuardKind =
  | "verify-block" // A2: step-done denied because the verify check hasn't gone red→green
  | "doom-loop" // A3: same tool call repeated 3× with identical input
  | "steps-cap" // A3: per-agent iteration cap hit → forced summarization
  | "allowlist-deny" // A6: tool call outside the step's declared tools
  | "mode-ask"; // B2: mutating call in Plan mode → ask

/** Confidence tier the event routes through once A4 (M6.2) is wired; interim = undefined. */
export type GuardTier = "green" | "yellow" | "red";

export interface GuardEvent {
  kind: GuardKind;
  stepId?: string;
  tier?: GuardTier;
  /** Human-readable evidence: which check failed, which call looped, which rule denied. */
  detail: string;
}

type GuardListener = (event: GuardEvent) => void;
const guardListeners = new Set<GuardListener>();

/** Subscribe to guard events (footer strip, ledger writers). Returns an unsubscribe fn. */
export function onGuardEvent(fn: GuardListener): () => void {
  guardListeners.add(fn);
  return () => {
    guardListeners.delete(fn);
  };
}

/** Fan a guard event out to all listeners. Emitters land in phases A2/A3/A6/B2. */
export function emitGuardEvent(event: GuardEvent): void {
  for (const fn of guardListeners) fn(event);
}
