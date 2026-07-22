/**
 * Classify Minima recommend-response warnings for display.
 *
 * The server (src/minima/recommender/engine.py) emits ~18 `warnings` strings, and they are
 * ALL benign/informational on a recommend response — they describe successful selection or
 * graceful degradation (thompson_pick, exploration_pick, no_model_meets_threshold,
 * collapse_guard_applied, prices_stale, no_model_within_*_budget, and the class-specific
 * memory-degradation labels memory_unreachable / memory_auth_failed / memory_rejected_payload /
 * memory_server_error / memory_recall_bug, …).
 * None is a hard failure. The old TUI used a 4-item DENYLIST and rendered everything else as
 * a red error, so any diagnostic not in the list (and any NEW server diagnostic) looked like
 * a failure. We invert that: recommend-path warnings are shown as a MUTED info note, never a
 * red error, and the noisiest purely-internal signals are hidden entirely.
 *
 * cold_start* and escalation_suggested:* are NOT hidden: they tell the user the pick is
 * running on thin/no evidence — but the raw strings (one per warning, unbreakable tokens)
 * would spill the turn cell, so the whole family collapses to ONE short phrase per turn.
 */

// Purely-internal signals with no user value — hidden completely.
const HIDDEN_PREFIXES = [
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

// Families collapsed into the single compact evidence note below.
const COMPACT_PREFIXES = ["cold_start", "escalation_suggested"];

/**
 * One short line for the whole cold-start / thin-evidence family (deduplicated: any
 * number of matching warnings yields at most this single phrase per turn). Null when
 * the turn carried neither.
 */
export function compactRoutingNote(warnings: readonly string[]): string | null {
  const cold = warnings.some((w) => w.startsWith("cold_start"));
  const thin = warnings.some((w) => w.startsWith("escalation_suggested"));
  if (cold && thin) return "cold start · thin evidence — pick based on priors";
  if (cold) return "cold start — no prior outcomes for this task yet";
  if (thin) return "thin evidence for this pick — worth verifying";
  return null;
}

/** Info-level warnings worth a muted one-liner (everything not hidden). Never errors. */
export function routingInfoWarnings(warnings: readonly string[]): string[] {
  const out: string[] = [];
  const note = compactRoutingNote(warnings);
  if (note) out.push(note);
  const seen = new Set<string>();
  for (const w of warnings) {
    if (COMPACT_PREFIXES.some((p) => w.startsWith(p))) continue;
    if (HIDDEN_PREFIXES.some((p) => w.startsWith(p))) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}
