/**
 * Failure-kind matchers (A4) — classify WHY a recovery rung failed and pick the intervention that
 * actually fits it, instead of the ladder's one blunt response ("always escalate to a pricier
 * model"). Resolved once per `promptRouted` and consulted after each rung in the recovery loop
 * (runtime.ts), the sibling seam to A2/A3 (which live at the per-turn `shouldStopAfterTurn`).
 *
 * Three failure kinds, one intervention each:
 *   - TRANSIENT (infra): a rate-limit / timeout / 5xx / network blip. The model isn't the problem,
 *     so → BACKOFF: retry the SAME (best) model, do NOT exclude it, and do NOT teach Minima it
 *     failed (a 429 is not evidence of low quality). An optional bounded delay (config.backoffMs)
 *     paces the retry.
 *   - CAPABILITY: the model produced a low-quality answer (judge < τ), or a non-transient provider
 *     error, or a FIRST deterministic 🔴 check-fail. A stronger model plausibly helps → ESCALATE:
 *     exclude the failed model and re-route to the next server rung (the ladder's classic move).
 *   - STRUCTURAL: a deterministic 🔴 that KEEPS failing across rungs — escalating to a stronger model
 *     didn't fix it, so the APPROACH is wrong, not the model → REPLAN: keep the model, inject a
 *     plan-revision steer, and let the agent rethink its steps/verify commands.
 *
 * The 🟢/🟡/🔴 vocabulary (big_plan_contract's ConfidenceTier) grades how concerning each recovery is —
 * backoff/escalate are 🟡 (recoverable), replan is 🔴 (the plan itself is suspect). Recovery
 * decisions leave an audit-only `recovery` gate (rec_id NULL → invisible to the feedback join, like
 * A2/A3's stop rows), never a model-facing verdict.
 *
 * Transient detection is a substring match over the error TEXT because provider errors surface as
 * an `AssistantMessage(stop_reason='error')` carrying only a free-text `error_message` (no status
 * field survives the ai layer); the OpenAI-compat path emits a literal `HTTP <status>`, Anthropic /
 * Google pass through SDK phrasing ("rate limit", "overloaded", "timed out", …).
 *
 * Pure + fail-open. Gated by `config.bigPlan && config.failureMatcher` at the call site; inert
 * otherwise, so the default path keeps the classic always-escalate ladder unchanged.
 */

import { Message, text } from "../ai/types.ts";
import type { MinimaDb } from "../db/minima_db.ts";
import type { ConfidenceTier } from "./big_plan_contract.ts";

/** Why a rung failed. */
export type FailureKind = "transient" | "capability" | "structural";
/** What to do about it — the ladder's three recovery moves. */
export type Intervention = "backoff" | "escalate" | "replan";

/**
 * A deterministic 🔴 becomes STRUCTURAL (→ replan) only after this many consecutive gate-failing rungs.
 * The FIRST deterministic fail still escalates (a stronger model may write correct code); only when
 * escalation demonstrably didn't help do we conclude the plan — not the model — is wrong.
 */
const REPLAN_AFTER_GATE_FAILS = 2;

/** Infra/transient error markers. Deliberately specific so a faux test error ("boom", "upstream
 * 500") never trips it — only genuine rate-limit / timeout / 5xx / network phrasing does. */
const TRANSIENT_RE =
  /HTTP\s*(?:429|5\d\d)|rate.?limit|too many requests|overloaded|\b529\b|timed?\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\bterminated\b|service unavailable|temporarily unavailable/i;

/** Is this error text a transient/infrastructure failure (not the model's fault)? */
export function isTransientError(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return TRANSIENT_RE.test(errorText);
}

/** How concerning each recovery is, in the shared 🟢/🟡/🔴 vocabulary. */
export const INTERVENTION_TIER: Record<Intervention, ConfidenceTier> = {
  backoff: "yellow", // infra blip — recoverable, low concern
  escalate: "yellow", // model swap — recoverable
  replan: "red", // the approach is wrong — serious
};

/** E2 named rung states (H-RePlan vocabulary): what each intervention IS in ladder terms —
 * retry_step (same model again), revise_step (stronger model, same plan), replan
 * (structural: revise the plan itself). Recorded on recovery gates and in the NEXT rung's
 * feedback notes so failure attribution reaches the server with its shape intact. */
export type RungName = "retry_step" | "revise_step" | "replan";
export const RUNG_NAMES: Record<Intervention, RungName> = {
  backoff: "retry_step",
  escalate: "revise_step",
  replan: "replan",
};

export const TIER_GLYPHS: Record<ConfidenceTier, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

/** The rung-outcome signals the matcher classifies. All four are already computed by the ladder. */
export interface FailureSignals {
  /** The run itself errored (a thrown error, or an assistant with `stop_reason==='error'`). */
  hardError: boolean;
  /** The error text (from `error_message` / the thrown value) — the transient/infra signal. */
  errorText: string | null;
  /** A REAL judge grade below the rung's threshold (never on an abstain). */
  judgeFailed: boolean;
  /** A grounded deterministic check FAILED this rung (🔴). */
  gateFailed: boolean;
}

/** The matcher's verdict for one failed rung. */
export interface FailureDecision {
  kind: FailureKind;
  intervention: Intervention;
  tier: ConfidenceTier;
  reason: string;
  /** E2: the named rung state this decision enters. */
  rung: RungName;
}

function decide(kind: FailureKind, intervention: Intervention, reason: string): FailureDecision {
  return {
    kind,
    intervention,
    tier: INTERVENTION_TIER[intervention],
    reason,
    rung: RUNG_NAMES[intervention],
  };
}

/**
 * Build the per-prompt failure matcher. The gate-fail streak is closed over here (one matcher per
 * `promptRouted`, consulted once per rung), so "the check is STILL failing after we already
 * escalated" is what promotes a 🔴 from capability→structural. Returns null for a rung that did not
 * fail (resetting the streak), else the chosen {@link FailureDecision}.
 */
export function makeFailureMatcher(): (signals: FailureSignals) => FailureDecision | null {
  let gateFailStreak = 0;
  return (s) => {
    const anyFailure = s.hardError || s.judgeFailed || s.gateFailed;
    if (!anyFailure) {
      gateFailStreak = 0;
      return null;
    }
    // A real deterministic check failed → the meaningful signal, and it OUTRANKS a coincidental
    // transient error on the same rung (gate rows are read from the persisted ledger, so a terminal
    // 429 does not erase a red the run already wrote). First try a stronger model; if the check keeps
    // failing across rungs, the approach — not the model — is wrong, so replan.
    if (s.gateFailed) {
      gateFailStreak += 1;
      if (gateFailStreak >= REPLAN_AFTER_GATE_FAILS) {
        return decide(
          "structural",
          "replan",
          `verification still failing after ${gateFailStreak} attempts — revise the plan`,
        );
      }
      return decide("capability", "escalate", "verification failed — trying a stronger model");
    }
    // A pure infra blip (no real check-fail) → retry the same model, don't blame it.
    if (s.hardError && isTransientError(s.errorText)) {
      gateFailStreak = 0;
      return decide("transient", "backoff", "transient/infra error — retrying the same model");
    }
    // A quality miss, or a non-transient provider error → a different/stronger model may do better.
    gateFailStreak = 0;
    return decide(
      "capability",
      "escalate",
      s.judgeFailed
        ? "quality below threshold — trying a stronger model"
        : "model run failed — trying a different model",
    );
  };
}

/** The plan-revision steer prepended to the next rung's prompt when the failure looks structural.
 * Prepended to the rung content (not pushed to `state.steering`) because steering only drains AFTER
 * a turn (loop.ts), so a between-rung steer would land one wasted turn late; prepending puts it in
 * front of the model on its FIRST action of the retry. */
export function replanPreamble(reason: string): string {
  return [
    `⚠ Your previous attempt failed verification and retrying has not fixed it (${reason}).`,
    "The problem is most likely your APPROACH, not the model. Before doing anything else, STEP BACK",
    "and REVISE YOUR PLAN: rethink the steps and their `verify` commands, break the failing step into",
    "smaller checkable steps, or correct a wrong assumption. Then execute the revised plan.",
  ].join("\n");
}

/** The replan steer as a message (exposed for callers that prefer a queued injection / for tests). */
export function replanMessage(reason: string): Message {
  return new Message({ role: "user", content: [text(replanPreamble(reason))] });
}

/** Identity/provenance a recovery audit row carries. */
export interface RecoveryGateDeps {
  db: MinimaDb | null;
  sessionId: string | null;
  agentId: string | null;
}

/**
 * Write the single audit-only `recovery` gate row for a backoff/replan decision. `recId: null`
 * keeps it out of the feedback join by construction (never inflates or fails a routed rung), like
 * A2/A3's `stop` rows; `sessionId`/`agentId` are provenance only. Fail-open — a bookkeeping write
 * must never break the recovery loop. (Escalate rungs already log via the per-rung feedback path.)
 */
export function writeRecoveryGate(deps: RecoveryGateDeps, decision: FailureDecision): void {
  if (!deps.db || !deps.sessionId) return;
  try {
    const plan = deps.db.getActivePlan(deps.sessionId);
    if (!plan) return;
    deps.db.insertGate({
      planId: plan.id,
      stepId: null,
      kind: "recovery",
      outcome: "unchecked",
      confidence: decision.tier,
      verifiedBy: null,
      factors: {
        recovery: true,
        kind: decision.kind,
        intervention: decision.intervention,
        rung: decision.rung,
        reason: decision.reason,
      },
      recId: null,
      sessionId: deps.sessionId,
      agentId: deps.agentId,
    });
  } catch {
    // audit is best-effort; never break the loop over a bookkeeping write.
  }
}

/** Why the recovery ladder gave up (audit `cause` on the terminal exhaustion gate). `transient`
 * keeps an infra storm (a 429/timeout/5xx across every rung) distinct from a genuine capability
 * exhaustion — the same distinction A4 draws on the feedback side must not blur in the audit. */
export type ExhaustionCause = "gate_failed" | "judge_failed" | "hard_error" | "transient";

/**
 * A7: the ladder walked every rung and the final one is STILL failing — write ONE terminal
 * audit-only `recovery` gate (`factors.exhausted=true`, tier 🔴) so an exhausted ladder is
 * inspectable (`/why`) instead of a silent `return`. Like {@link writeRecoveryGate} it carries
 * `recId: null` (invisible to the feedback join — it can never inflate/fail a routed rung) and is
 * best-effort/fail-open. Distinct `kind='exhausted'` factor separates it from a per-rung
 * backoff/replan row: those recovered, this one did not. Emitted once per exhausted prompt.
 *
 * Plan resolution falls back to the LATEST plan when no plan is `active`: a judge_failed or
 * hard_error exhaustion can arrive AFTER the plan already closed to `done` (all verify-less steps
 * marked complete), and dropping the row there would leave `ladderExhausted` counting an exhaustion
 * with no gate to explain it — the exact silent-return this feature exists to remove.
 */
export function writeExhaustionGate(deps: RecoveryGateDeps, cause: ExhaustionCause): void {
  if (!deps.db || !deps.sessionId) return;
  try {
    const plan =
      deps.db.getActivePlan(deps.sessionId) ??
      deps.db.getLatestPlan(deps.sessionId, { excludeCancelled: true });
    if (!plan) return;
    deps.db.insertGate({
      planId: plan.id,
      stepId: null,
      kind: "recovery",
      outcome: "unchecked",
      confidence: "red",
      verifiedBy: null,
      factors: {
        recovery: true,
        kind: "exhausted",
        exhausted: true,
        cause,
        reason: "recovery ladder exhausted — every rung spent, still failing",
      },
      recId: null,
      sessionId: deps.sessionId,
      agentId: deps.agentId,
    });
  } catch {
    // audit is best-effort; never break the loop over a bookkeeping write.
  }
}
