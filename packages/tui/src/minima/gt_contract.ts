/**
 * Ground-Truth contract — the frozen hand-off between the two build tracks
 * (see docs/ground-truth-build-guide.md §5b, "Step 0"). This is the seam that lets the two
 * tracks run in parallel:
 *
 *   Track A (the "check engine" / producer) runs checks, computes the raw `Factors`, and
 *   writes gate rows. Track B (trust, UI & learning / consumer) reads those factors, tiers
 *   them into a `ConfidenceVerdict`, drives the UI, and feeds Minima.
 *
 * This module is PURE: types + frozen value lists only, with ZERO runtime dependencies. Both
 * tracks — and the DB boundary in `../db/minima_db.ts` — import from here (via `import type`
 * where they only need the unions), so the enum spellings can never drift apart.
 *
 * Each string enum is declared once as an `as const` tuple and its union is derived from it,
 * so the allowed set is frozen at BOTH compile time (the union) and runtime (the array, which
 * `tests/gt-contract.test.ts` asserts and round-trips through the DB).
 *
 * Rule: do not widen these unions back to `string`. To add a value, extend the tuple (its
 * union updates automatically) and the matching test.
 */

// ---------------------------------------------------------------------------
// Frozen value sets → derived unions. The tuple is the single source of truth.
// ---------------------------------------------------------------------------

/**
 * A gate's verdict — `gates.outcome`. `unchecked` (M4.3): the step was allowed to complete
 * with no `verify` attached — no evidence either way, recorded so the completion still leaves
 * a durable row (verified_by NULL, factors.hasCheck false).
 */
export const GATE_OUTCOMES = ["verified", "failed", "unrunnable", "unchecked"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** Confidence tier — `gates.confidence` / `routing_decisions.gt_confidence`. Also the UI tier. */
export const CONFIDENCE_TIERS = ["green", "yellow", "red"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

/** Who produced the verdict — `gates.verified_by` / `routing_decisions.gt_verified_by`. */
export const VERIFIED_BY = ["deterministic", "judge", "user"] as const;
export type VerifiedBy = (typeof VERIFIED_BY)[number];

/**
 * Kind of gate — `gates.kind`. `stop` (A2): a plan-level row written when the run-level stop-gate
 * denies the agent's attempt to END the run with unfinished/failing steps and, after N strikes,
 * lets it stop anyway. Audit-only — written with `recId: null` so it is invisible to the feedback
 * join by construction (never inflates or fails a routed rung); the real per-step evidence lives in
 * the `step_check` rows it summarises.
 */
export const GATE_KINDS = ["step_check", "milestone", "stop"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** Pre-work baseline captured when a step starts — `plan_steps.baseline` (M3.3). */
export const BASELINES = ["red", "green", "unrunnable"] as const;
export type Baseline = (typeof BASELINES)[number];

/** A user's override recorded against a gate — `user_signals.action` (M6.3). */
export const USER_ACTIONS = ["accept", "reject", "steer"] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

/** Where a step's check came from — a `Factors.checkOrigin` value (M5.1). */
export const CHECK_ORIGINS = ["pre_existing", "agent_new", "user"] as const;
export type CheckOrigin = (typeof CHECK_ORIGINS)[number];

// ---------------------------------------------------------------------------
// Structured hand-off shapes.
// ---------------------------------------------------------------------------

/**
 * The raw verification facts Track A computes for a step and stores in `gates.factors_json`.
 * Track B's `confidence()` consumes exactly this shape — this interface IS the parallelization
 * seam, so keep it the single source of truth for both tracks.
 */
export interface Factors {
  /** Did the step's check pass on the post-work run? (M3.2 / M4.1) */
  pass: boolean;
  /** Baseline was red AND the post-work run is green — real evidence the step did something. (M4.2) */
  redToGreen: boolean;
  /** The step wrote code but carries no acceptance check at all → caps the tier at 🟡. (M6.1) */
  hasCheck: boolean;
  /** Provenance: a pre-existing test (trust) vs one the agent wrote this run (scrutiny). (M5.1) */
  checkOrigin: CheckOrigin;
  /** Does the check actually exercise the changed file? `"unknown"` when we can't tell. (M5.2) */
  coverageHit: boolean | "unknown";
  /** Tests were skipped/deleted/weakened this step — always forces 🔴. (M5.3) */
  tamper: boolean;
  /**
   * Unattributable writes happened this run (opaque bash mutations, worktree sub-agents) —
   * provenance/coverage were computed from knowably incomplete data, so the tier caps at 🟡:
   * signal lost, never fabricated. Optional/additive (older factors_json rows lack it).
   */
  blind?: boolean;
}

/** Track B's `confidence()` output (M6.1): one tier plus a human-readable reason. */
export interface ConfidenceVerdict {
  tier: ConfidenceTier;
  reason: string;
}

/** `runCheck()`'s return shape (M3.2) — the primitive everything in Stages 4–6 leans on. */
export interface CheckResult {
  pass: boolean;
  output: string;
  durationMs: number;
}
