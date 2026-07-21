/**
 * Zero-context diff reviewer (E1) — after a plan closes with all steps completed, a
 * reviewer that has seen NOTHING of the session (no plan, no transcript, no ledger —
 * deliberate quarantine: fresh eyes are the feature, and the one multi-agent pattern
 * Cognition endorses) reads the run's whole diff and either approves or objects.
 *
 * Trust ladder: an objection lands as a plan-level milestone gate — verified_by "judge",
 * confidence "yellow" — so worst-tier resolution can YELLOW the plan's tier; an approval
 * writes NOTHING (the reviewer can never mint or upgrade positive evidence), and an
 * unusable reply is skipped (advisory-negative-only: noise must not degrade a real
 * green). Distinct from plan_refute.ts on purpose: the refuter gets the ledger's own
 * story and re-runs checks; this reviewer judges the code change alone.
 */

import { complete } from "../ai/stream.ts";
import { Message, type Model } from "../ai/types.ts";
import type { MinimaDb } from "../db/minima_db.ts";
import { stampVerifiedOutcome } from "./big_plan.ts";
import { midTruncate } from "./judge.ts";

export const DIFF_REVIEW_SYSTEM =
  "You are reviewing a code change with deliberately NO other context — no task " +
  "description, no plan, no conversation. Judge the diff alone. Object only to concrete " +
  "defects a reviewer would block on: introduced bugs, half-finished edits (dead " +
  "branches, TODO stubs presented as done), deleted or weakened tests, debug leftovers, " +
  "obvious security problems. Style and taste are NOT objections. Reply with first line " +
  'EXACTLY "VERDICT: approve" or "VERDICT: object"; when objecting add a "CONCERNS:" ' +
  'line followed by one "- " bullet per concrete defect (at most 6).';

/** Cap the diff shown to the reviewer; both ends kept (mid-truncated like the judge). */
export const DIFF_REVIEW_CAP_CHARS = 24_000;

export interface DiffReviewVerdict {
  objects: boolean;
  concerns: string[];
}

/** Fail-quiet parse: null = unusable reply (skip — never fabricate an objection). */
export function parseDiffReviewVerdict(text: string): DiffReviewVerdict | null {
  const m = /^\s*VERDICT:\s*(approve|object)\b/im.exec(text);
  if (!m) return null;
  const objects = m[1]!.toLowerCase() === "object";
  const concerns: string[] = [];
  let inConcerns = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*CONCERNS:\s*$/i.test(line)) {
      inConcerns = true;
      continue;
    }
    const bullet = /^\s*[-•]\s+(.*\S)/.exec(line);
    if (inConcerns && bullet) concerns.push(bullet[1]!.slice(0, 200));
    if (concerns.length >= 6) break;
  }
  return { objects, concerns };
}

/** The run's whole change as one patch: committed since base + the working tree. */
export function collectRunDiff(top: string, baseSha: string | null): string | null {
  try {
    const args = baseSha ? ["git", "diff", baseSha] : ["git", "diff", "HEAD"];
    const proc = Bun.spawnSync(args, { cwd: top });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString();
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

export interface DiffReviewOutcome {
  verdict: DiffReviewVerdict;
  /** Set only on objection — the yellow milestone gate that carries the concerns. */
  gateId: string | null;
}

export interface DiffReviewOptions {
  db: MinimaDb;
  sessionId: string;
  planId: string;
  metaModel: Model | null;
  /** Pre-collected diff (callers use collectRunDiff). Empty/null → skip. */
  diff: string | null;
  signal?: AbortSignal | null;
  onCostUsd?: (usd: number) => void;
  completeFn?: typeof complete;
}

/**
 * Run the reviewer end-to-end. Returns null when skipped (no model / no diff / abort /
 * unusable reply / error) — a skip writes nothing and never degrades a tier.
 */
export async function runDiffReview(opts: DiffReviewOptions): Promise<DiffReviewOutcome | null> {
  if (!opts.metaModel || !opts.diff?.trim() || opts.signal?.aborted) return null;
  const run = opts.completeFn ?? complete;
  let verdict: DiffReviewVerdict | null;
  try {
    const resp = await run(
      opts.metaModel,
      {
        system_prompt: DIFF_REVIEW_SYSTEM,
        messages: [
          new Message({
            role: "user",
            content: `The complete change:\n\n${midTruncate(opts.diff, DIFF_REVIEW_CAP_CHARS)}`,
          }),
        ],
        tools: [],
      },
      { options: { timeout: 45, prompt_cache: false } },
    );
    try {
      const usd = resp.usage.cost.total;
      opts.onCostUsd?.(Number.isFinite(usd) ? usd : 0);
    } catch {
      // spend hooks must never break the review
    }
    if (resp.stop_reason === "error") return null;
    verdict = parseDiffReviewVerdict(resp.textContent);
  } catch {
    return null;
  }
  if (verdict === null) return null;
  if (!verdict.objects) return { verdict, gateId: null };

  // Objection → a judge-verified yellow milestone gate. Worst-tier resolution yellows
  // the plan; outcome stays "verified" (the work stands — concerns, not a refutation),
  // so the recovery ladder and big_plan_outcome labels never flip to failure on advisory input.
  const decisions = opts.db.getRunDecisions(opts.sessionId);
  const recId = (decisions.at(-1)?.rec_id as string | undefined) ?? null;
  const gateId = opts.db.insertGate({
    planId: opts.planId,
    stepId: null,
    kind: "milestone",
    outcome: "verified",
    confidence: "yellow",
    verifiedBy: "judge",
    factors: {
      diff_review: true,
      flipContent: "zero-context diff review",
      concerns: verdict.concerns,
    },
    recId,
    sessionId: opts.sessionId,
  });
  if (recId) stampVerifiedOutcome(opts.db, recId);
  return { verdict, gateId };
}
