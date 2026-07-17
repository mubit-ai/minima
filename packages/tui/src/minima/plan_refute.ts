/**
 * Whole-plan verification subagent (J1.2, borrow #9) — an adversarial refutation pass over
 * the finished (or finishing) plan, run through the SAME spawn seam as council research.
 *
 * The child gets the ledger's own story (steps, checks, gate history, drift) and is asked
 * to REFUTE it: re-run every verify command, read what changed, and prove the plan is NOT
 * done. Its verdict lands as a plan-level `milestone` gate with `verified_by: "judge"` —
 * never "deterministic" (an agent's opinion must not outrank a real check in the trust
 * ladder) and never 🟢 (judge-verified caps at 🟡; refuted → 🔴). The gate carries the
 * run's latest rec_id so stampGroundedOutcome feeds gt_outcome — deterministic step gates
 * still dominate the identity join (red wins, worst tier otherwise). Fail-closed parsing:
 * an unparseable or aborted verdict never mints "verified".
 */

import type { MinimaDb } from "../db/minima_db.ts";
import type { ChildResult, Delegation, SpawnFn } from "../tools/task.ts";
import { stampGroundedOutcome } from "./ground_truth.ts";
import { gateVerdictFor } from "./why.ts";

export interface RefutationVerdict {
  refuted: boolean;
  reasons: string[];
  /** Child's full reply — kept for the gate's factors (auditable evidence). */
  raw: string;
}

export const REFUTATION_STEP_ID = "plan-refutation";

/** Build the child's brief from the ledger; null when there is no plan or no steps. */
export function buildRefutationDelegation(db: MinimaDb, sessionId: string): Delegation | null {
  const plan =
    db.getActivePlan(sessionId) ?? db.getLatestPlan(sessionId, { excludeCancelled: true });
  if (!plan) return null;
  const steps = db.getPlanSteps(plan.id);
  if (steps.length === 0) return null;

  const gatesByStep = new Map<string, string>();
  for (const gate of db.getGates(plan.id)) {
    if (!gate.step_id) continue;
    const verdict = gateVerdictFor(gate);
    gatesByStep.set(
      gate.step_id,
      `${gate.outcome ?? "?"} (${verdict.tier ?? "untiered"} — ${verdict.reason})`,
    );
  }
  const drift = db
    .getFileChanges(plan.id)
    .filter((c) => c.origin === "off_plan")
    .map((c) => c.path);

  const lines = [
    `The plan "${plan.title?.trim() || plan.id}" claims the following steps and evidence:`,
    "",
  ];
  for (const step of steps) {
    lines.push(`${step.idx + 1}. [${step.status ?? "?"}] ${step.content ?? ""}`);
    lines.push(`   check: ${step.verify?.trim() || "(none)"}`);
    if (step.verify_cwd) lines.push(`   cwd: ${step.verify_cwd}`);
    lines.push(`   latest gate: ${gatesByStep.get(step.id) ?? "(never gated)"}`);
  }
  if (drift.length > 0) {
    lines.push("", `Off-plan file changes (drift): ${drift.join(", ")}`);
  }
  lines.push(
    "",
    "Your job is to REFUTE this plan's completion. Re-run every check command exactly as",
    "written (bash), read the files the plan touched, and hunt for: checks that fail or",
    "cannot run, steps whose check does not actually exercise the claimed change, weakened",
    "or deleted tests, and drift that contradicts a step. Passing checks are NOT proof by",
    "themselves — say so when a check is too weak to protect its step.",
  );

  return {
    step_id: REFUTATION_STEP_ID,
    objective: lines.join("\n"),
    output_format:
      'First line EXACTLY "VERDICT: confirmed" (could not refute) or "VERDICT: refuted".' +
      ' Then a line "REASONS:" followed by one "- " bullet per finding (refuted: every hole' +
      " you found; confirmed: what you re-ran and why it held).",
    boundaries:
      "READ-ONLY verification: never modify, create, or delete files; never run write/edit/" +
      "apply_patch; bash only for the listed check commands and read-only inspection.",
    tool_guidance: "bash to re-run checks, read/grep to inspect the touched files.",
    difficulty: "expert",
    effort: "deep",
  };
}

/**
 * Fail-closed verdict parse: only an explicit "VERDICT: confirmed" counts as not-refuted;
 * anything missing or garbled is refuted (a verification pass that cannot state its verdict
 * must never mint verified).
 */
export function parseRefutationVerdict(text: string): RefutationVerdict {
  const lines = text.split(/\r?\n/);
  let verdict: "confirmed" | "refuted" | null = null;
  const reasons: string[] = [];
  let inReasons = false;
  for (const line of lines) {
    const v = /^\s*VERDICT:\s*(confirmed|refuted)\b/i.exec(line);
    if (v && verdict === null) {
      verdict = v[1]!.toLowerCase() as "confirmed" | "refuted";
      continue;
    }
    if (/^\s*REASONS:\s*$/i.test(line)) {
      inReasons = true;
      continue;
    }
    const bullet = /^\s*[-•]\s+(.*\S)/.exec(line);
    if (inReasons && bullet) reasons.push(bullet[1]!);
  }
  if (verdict === null) {
    return {
      refuted: true,
      reasons: ["verdict missing/unparseable — treated as refuted (never fabricate verification)"],
      raw: text,
    };
  }
  return { refuted: verdict === "refuted", reasons, raw: text };
}

export interface RefutationOutcome {
  gateId: string;
  verdict: RefutationVerdict;
  /** rec the gate joined (latest routed rung of the run), null when the run has none. */
  recId: string | null;
  childCostUsd: number;
}

/**
 * Run the refutation pass end-to-end: build the brief, spawn the child, parse fail-closed,
 * write the plan-level milestone gate (judge-verified, 🟡 cap / 🔴 refuted), and stamp the
 * grounded outcome onto the run's latest rec. Returns null when there is no plan to verify
 * or the child was aborted (an aborted pass records nothing — never a fabricated verdict).
 */
export async function runPlanRefutation(opts: {
  db: MinimaDb;
  sessionId: string;
  spawn: SpawnFn;
  signal?: AbortSignal | null;
}): Promise<RefutationOutcome | null> {
  const delegation = buildRefutationDelegation(opts.db, opts.sessionId);
  if (!delegation) return null;
  const plan =
    opts.db.getActivePlan(opts.sessionId) ??
    opts.db.getLatestPlan(opts.sessionId, { excludeCancelled: true });
  if (!plan) return null;

  let child: ChildResult;
  try {
    child = await opts.spawn(delegation, {
      depth: 0,
      parentSignal: opts.signal ?? null,
      priorResults: [],
    });
  } catch (exc) {
    child = {
      step_id: delegation.step_id,
      childId: "refutation-failed",
      text: `VERDICT: refuted\nREASONS:\n- verification subagent failed to run: ${String(exc)}`,
      costUsd: 0,
      quality: null,
      outcome: "failure",
      workdir: null,
    };
  }
  if (child.outcome === "aborted") return null;

  const verdict = parseRefutationVerdict(child.text);
  const decisions = opts.db.getRunDecisions(opts.sessionId);
  const recId = (decisions.at(-1)?.rec_id as string | undefined) ?? null;

  const gateId = opts.db.insertGate({
    planId: plan.id,
    stepId: null,
    kind: "milestone",
    outcome: verdict.refuted ? "failed" : "verified",
    confidence: verdict.refuted ? "red" : "yellow",
    verifiedBy: "judge",
    factors: {
      refutation: true,
      flipContent: "whole-plan refutation pass",
      reasons: verdict.reasons,
      childId: child.childId,
      childOutcome: child.outcome,
      costUsd: child.costUsd,
    },
    recId,
    sessionId: opts.sessionId,
  });
  if (recId) stampGroundedOutcome(opts.db, recId);
  return { gateId, verdict, recId, childCostUsd: child.costUsd };
}
