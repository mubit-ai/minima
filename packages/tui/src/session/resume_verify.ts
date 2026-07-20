/**
 * Resume re-verify (D2) — transcript replay alone restores a run correctly only when the
 * working tree still matches what the transcript believes (Crab: ~8% of the time). The
 * tree is co-equal state, so on resume the in-progress step's verify command is re-run
 * and compared against its recorded baseline: matching → proceed silently; diverged →
 * re-baseline (stamped + evented) and a 🟡 banner so the model re-derives from reality
 * instead of trusting stale history.
 *
 * MP18 holds on this path too: verify commands are LLM-authored shell, so the same
 * consent gate applies — an unapproved command is never executed at resume; the skip is
 * reported, not silent.
 */

import type { MinimaDb, PlanStepRow } from "../db/minima_db.ts";
import { baselineFromResult, runCheck } from "../minima/check.ts";
import type { Baseline } from "../minima/gt_contract.ts";

export interface ResumeVerifyResult {
  stepId: string;
  stepContent: string;
  verify: string;
  recordedBaseline: Baseline | null;
  /** Null when the check never ran (consent denied / aborted). */
  fresh: Baseline | null;
  /** True when a recorded baseline exists and the fresh result contradicts it. */
  diverged: boolean;
  skipped: "consent" | "aborted" | null;
}

/** The step a resume should re-verify: in_progress with a verify command. Null = none. */
export function stepToReverify(db: MinimaDb, planSessionId: string): PlanStepRow | null {
  const plan = db.getActivePlan(planSessionId);
  if (!plan) return null;
  return (
    db.getPlanSteps(plan.id).find((s) => s.status === "in_progress" && s.verify?.trim()) ?? null
  );
}

/**
 * Re-run the in-progress step's check on resume. Null = nothing to re-verify. On a
 * divergence the step is re-baselined (setStepBaseline) so later done-gate red→green
 * evidence measures from reality, and a `resume_reverify` event lands on `eventRunId`.
 * Total: never throws; every skip is explicit in the result.
 */
export async function reverifyOnResume(opts: {
  db: MinimaDb;
  /** Session whose ACTIVE plan holds the step (post-adoption run, or the resumed run). */
  planSessionId: string;
  /** Run the audit event lands on (the current run). */
  eventRunId: string;
  consent: (cmd: string) => boolean;
  signal?: AbortSignal | null;
}): Promise<ResumeVerifyResult | null> {
  try {
    const step = stepToReverify(opts.db, opts.planSessionId);
    if (!step) return null;
    const verify = step.verify!.trim();
    const base: Omit<ResumeVerifyResult, "fresh" | "diverged" | "skipped"> = {
      stepId: step.id,
      stepContent: step.content ?? "",
      verify,
      recordedBaseline: step.baseline,
    };
    if (!opts.consent(verify)) {
      return { ...base, fresh: null, diverged: false, skipped: "consent" };
    }
    const result = await runCheck(verify, {
      cwd: step.verify_cwd ?? undefined,
      signal: opts.signal ?? undefined,
    });
    if (opts.signal?.aborted) {
      return { ...base, fresh: null, diverged: false, skipped: "aborted" };
    }
    const fresh = baselineFromResult(result);
    const diverged = step.baseline !== null && fresh !== step.baseline;
    if (diverged || step.baseline === null) {
      // Diverged → re-baseline from reality; never captured → capture now (M3.3 is
      // once-only, and resume is a legitimate "work is about to continue" boundary).
      try {
        opts.db.setStepBaseline(step.id, fresh);
      } catch {
        // bookkeeping is fail-open
      }
    }
    try {
      opts.db.appendEvent({
        runId: opts.eventRunId,
        type: "resume_reverify",
        payload: {
          step_id: step.id,
          verify,
          recorded_baseline: step.baseline,
          fresh_baseline: fresh,
          diverged,
        },
      });
    } catch {
      // bookkeeping is fail-open
    }
    return { ...base, fresh, diverged, skipped: null };
  } catch {
    return null;
  }
}

/** The 🟡 banner for a divergence (or the consent-skip note); null when nothing to say. */
export function reverifyNotice(r: ResumeVerifyResult | null): string | null {
  if (!r) return null;
  if (r.skipped === "consent") {
    return `Resume: step "${r.stepContent}" has a verify (\`${r.verify}\`) that was never approved in this session — it was NOT re-run. It will ask for approval at the next done-gate.`;
  }
  if (r.skipped === "aborted" || r.fresh === null) return null;
  if (r.diverged) {
    return `🟡 Resume re-verify: step "${r.stepContent}" — its check went ${r.recordedBaseline} → ${r.fresh} while the session was away. The working tree moved; re-baselined from reality (verify: \`${r.verify}\`).`;
  }
  return null;
}
