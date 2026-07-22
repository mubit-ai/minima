import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import type { ConfidenceTier, Factors } from "./big_plan_contract.ts";
import { confidence } from "./confidence.ts";
import { gateVerdictFor } from "./why.ts";

/**
 * Plan-verification tier → behavior (M6.2). The pure projection from a step's confidence tier onto
 * what the UI must do about it. This is the "near-zero interruptions" rule: 🟢 proceeds silently,
 * 🟡 proceeds but is counted toward a single milestone-review footer note, and 🔴 stops the run
 * and raises an approval prompt. Kept free of React/DB so it can be unit-tested against the
 * confidence ladder alone; the app wires the aggregate ({@link ledgerBehavior}) into the footer.
 */

/** What a tier makes the UI do: keep going, or stop and ask. */
export type TierAction = "proceed" | "prompt";

/** One step's tier reduced to the decision the footer/prompt layer needs. */
export interface StepBehavior {
  /** The tier this decision came from; null when the step has no verdict yet. */
  tier: ConfidenceTier | null;
  /** `"prompt"` only for 🔴; otherwise `"proceed"`. */
  action: TierAction;
  /** False only for 🔴 — a red gate halts the run at that step. */
  proceed: boolean;
  /** True only for 🟡 — the step counts toward the milestone-review footer note. */
  flagged: boolean;
  /** Human-readable reason carried through from the confidence verdict. */
  reason: string;
}

/**
 * Map a single confidence tier onto its behavior. A null tier (an unchecked step, or a gate whose
 * factors couldn't be read) is treated as "nothing to gate on" — proceed quietly rather than
 * inventing a stop, so a missing verdict never blocks the run.
 */
export function tierBehavior(tier: ConfidenceTier | null, reason: string): StepBehavior {
  switch (tier) {
    case "green":
      return { tier, action: "proceed", proceed: true, flagged: false, reason };
    case "yellow":
      return { tier, action: "proceed", proceed: true, flagged: true, reason };
    case "red":
      return { tier, action: "prompt", proceed: false, flagged: false, reason };
    default:
      return { tier: null, action: "proceed", proceed: true, flagged: false, reason };
  }
}

/**
 * The 🟡 milestone-review footer note (M6.2): `🟡 N steps flagged — review at milestone`, or null
 * when nothing is flagged so the footer collapses. Singular/plural is handled so a single flagged
 * step reads `1 step flagged`.
 */
export function flaggedFooter(count: number): string | null {
  if (count <= 0) return null;
  return `🟡 ${count} step${count === 1 ? "" : "s"} flagged — review at milestone`;
}

/** The 🔴 approval prompt line: `🔴 <reason> — [v]iew / [a]ccept / [r]eject / [s]teer` (M6.2/M6.3). */
export function redPrompt(reason: string): string {
  return `🔴 ${reason} — [v]iew / [a]ccept / [r]eject / [s]teer`;
}

/** A blocking 🔴 gate the run stopped on, with the prompt text the footer should raise. */
export interface RedBlock {
  gateId: string;
  stepId: string | null;
  reason: string;
  prompt: string;
}

/** The whole ledger's tier→behavior reduced to what the footer + approval prompt render. */
export interface LedgerBehavior {
  /** How many 🟡 steps feed the milestone-review note. */
  flaggedCount: number;
  /** The rendered 🟡 footer note, or null when nothing is flagged. */
  footerNote: string | null;
  /** The earliest 🔴 step blocking progress, or null when nothing is blocked. */
  block: RedBlock | null;
}

/**
 * The tier→behavior for the persisted `confidence` on a gate row (M6.2's "store confidence on the
 * gate row" seam). Track A writes `insertGate({ confidence: gateConfidence(factors), … })` so the
 * stored tier is always the confidence ladder's own verdict — the exact value {@link gateVerdictFor}
 * prefers when it reads the gate back — and never drifts from what Track B would derive.
 */
export function gateConfidence(factors: Factors): ConfidenceTier {
  return confidence(factors).tier;
}

/**
 * Aggregate the active plan's gates into the behavior the footer + approval prompt need. Uses the
 * newest gate per step (a retry supersedes its earlier gate) read in plan-step order, so the block
 * is the *earliest* step still red — the one the run actually halts on. Tiers resolve through
 * {@link gateVerdictFor}, so a gate reads identically here and in `/why`.
 *
 * Total and fail-open: a null db/session, no active plan, or any DB error yields the empty
 * behavior (proceed silently, no note, no block) rather than throwing into the render loop.
 */
export function ledgerBehavior(db: MinimaDb | null, sessionId: string | null): LedgerBehavior {
  const empty: LedgerBehavior = { flaggedCount: 0, footerNote: null, block: null };
  if (!db || !sessionId) return empty;
  try {
    const plan = db.getActivePlan(sessionId);
    if (!plan) return empty;

    const latestGateByStep = new Map<string, GateRow>();
    for (const gate of db.getGates(plan.id)) {
      if (gate.step_id) latestGateByStep.set(gate.step_id, gate);
    }

    let flaggedCount = 0;
    let block: RedBlock | null = null;
    for (const step of db.getPlanSteps(plan.id)) {
      const gate = latestGateByStep.get(step.id);
      if (!gate) continue;
      const verdict = gateVerdictFor(gate);
      const step_behavior = tierBehavior(verdict.tier, verdict.reason);
      if (step_behavior.flagged) flaggedCount += 1;
      // The first red in plan order is where the run stopped; keep it, ignore later reds.
      // M6.3: a gate the user has already answered (accept/reject/steer) is resolved — it no
      // longer blocks, so skip it and let the run surface the next unanswered red (if any).
      if (!step_behavior.proceed && !block && db.getUserSignals(gate.id).length === 0) {
        block = {
          gateId: gate.id,
          stepId: step.id,
          reason: verdict.reason,
          prompt: redPrompt(verdict.reason),
        };
      }
    }

    return { flaggedCount, footerNote: flaggedFooter(flaggedCount), block };
  } catch {
    return empty;
  }
}
