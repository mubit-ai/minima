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

/** Agent-side facts routingSurfaceNotes reads (a plain snapshot — keeps it pure/testable). */
export interface RoutingSurfaceState {
  lastAborted: boolean;
  offlineReason: string | null;
  offlineKind: "network" | "budget" | null;
  lastFeedbackError: string | null;
  modelId: string | null;
}

export interface RoutingSurface {
  /** New decision-basis label for the footer; null = leave unchanged. */
  basis: string | null;
  /** Muted info notes for the transcript (never errors). */
  notes: string[];
}

/**
 * Build the post-turn routing notes surfaced in the transcript (the pure core of the
 * TUI's surfaceRouting). One source of truth for the normal path and the plan-mode
 * planner reply.
 */
export function routingSurfaceNotes(
  routing: { decisionBasis: string; warnings: readonly string[] } | null,
  state: RoutingSurfaceState,
): RoutingSurface {
  // Esc during routing is a USER abort — no model ran, nothing is offline. An honest
  // one-liner, never the "routing offline / Minima unreachable" note (MUB-174).
  if (state.lastAborted) {
    return { basis: null, notes: ["ℹ aborted during routing — no model ran."] };
  }
  if (routing) {
    const notes: string[] = [];
    const info = routingInfoWarnings(routing.warnings);
    if (info.length > 0) notes.push(`ℹ ${info.join("; ")}`);
    if (state.lastFeedbackError) notes.push(`ℹ learning loop: ${state.lastFeedbackError}`);
    return { basis: routing.decisionBasis || "minima", notes };
  }
  const model = state.modelId ?? "default model";
  // A structured budget-infeasibility rejection is NOT connectivity offline: the service is
  // up and said "no model fits this cost cap" — label it honestly and point at /budget.
  if (state.offlineKind === "budget") {
    return {
      basis: "offline",
      notes: [
        `ℹ budget-infeasible: ${state.offlineReason ?? "no model within the per-call cost cap"} — ran ${model} unrouted. Raise it with /budget set <usd> or relax with /budget mode warn.`,
      ],
    };
  }
  return {
    basis: "offline",
    notes: [
      `ℹ routing offline: ${state.offlineReason ?? "Minima unreachable"} — ran ${model} unrouted. /reconnect to retry.`,
    ],
  };
}
