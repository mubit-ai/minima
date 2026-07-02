/**
 * Classify Minima recommend-response warnings for display.
 *
 * The server (src/minima/recommender/engine.py) emits ~18 `warnings` strings, and they are
 * ALL benign/informational on a recommend response — they describe successful selection or
 * graceful degradation (thompson_pick, exploration_pick, no_model_meets_threshold,
 * collapse_guard_applied, prices_stale, memory_unavailable, no_model_within_*_budget, …).
 * None is a hard failure. The old TUI used a 4-item DENYLIST and rendered everything else as
 * a red error, so any diagnostic not in the list (and any NEW server diagnostic) looked like
 * a failure. We invert that: recommend-path warnings are shown as a MUTED info note, never a
 * red error, and the noisiest purely-internal signals are hidden entirely.
 */

// Purely-internal signals with no user value — hidden completely.
const HIDDEN_PREFIXES = [
  "cold_start",
  "reasoner_disabled",
  "reasoner_consulted",
  "recall_timeout",
  "prices_stale",
  "thompson_pick",
  "exploration_pick",
  "llm_classified",
  "neighbor_classified",
  "collapse_guard_applied",
];

/** Info-level warnings worth a muted one-liner (everything not hidden). Never errors. */
export function routingInfoWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => !HIDDEN_PREFIXES.some((p) => w.startsWith(p)));
}
