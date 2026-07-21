import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import { confidence } from "./confidence.ts";
import { CHECK_ORIGINS } from "./big_plan_contract.ts";
import type { CheckOrigin, ConfidenceTier, Factors } from "./big_plan_contract.ts";

const TIER_GLYPHS: Record<ConfidenceTier, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

/**
 * A gate reduced to what the UI needs: its recorded outcome, the confidence tier (stored, or
 * derived from `factors_json` when Track A hasn't stamped one yet), and a human reason. Shared
 * between `/why` and the M6.2 tier→behavior wiring so both read a gate identically.
 */
export interface GateVerdict {
  outcome: GateRow["outcome"];
  tier: ConfidenceTier | null;
  reason: string;
}

export function whyReportFor(db: MinimaDb | null, sessionId: string | null): string {
  if (!db || !sessionId) return "No Big Plan ledger available.";
  const plan = db.getLatestPlan(sessionId, { excludeCancelled: true });
  if (!plan) {
    const orphans = orphanLines(db, sessionId);
    return orphans.length > 0
      ? ["No Big Plan recorded for this run.", ...orphans].join("\n")
      : "No Big Plan recorded for this run.";
  }

  const steps = db.getPlanSteps(plan.id);
  const latestGateByStep = new Map<string, GateRow>();
  for (const gate of db.getGates(plan.id)) {
    if (gate.step_id) latestGateByStep.set(gate.step_id, gate);
  }

  const driftByStep = new Map<string, string[]>();
  const unattributedDrift: string[] = [];
  for (const change of db.getFileChanges(plan.id)) {
    if (change.origin !== "off_plan") continue;
    if (!change.step_id) {
      unattributedDrift.push(change.path);
      continue;
    }
    const paths = driftByStep.get(change.step_id) ?? [];
    paths.push(change.path);
    driftByStep.set(change.step_id, paths);
  }

  const lines = [`Big Plan verification - ${plan.title?.trim() || plan.id}`];
  if (steps.length === 0) lines.push("No plan steps recorded.");
  for (const step of steps) {
    const gate = latestGateByStep.get(step.id);
    const display = gateVerdictFor(gate);
    // ✓ verified · ✗ a real check that failed/couldn't run · ○ everything else (unchecked step,
    // or no gate). `unchecked` is NOT a failure — a step that completed with no check must not
    // read as ✗, or every check-less plan looks like a wall of failures.
    const icon =
      display.outcome === "verified"
        ? "✓"
        : display.outcome === "failed" || display.outcome === "unrunnable"
          ? "✗"
          : "○";
    const verdict = display.tier
      ? `${TIER_GLYPHS[display.tier]} ${display.reason}`
      : display.reason;
    lines.push(`${icon} step ${step.idx + 1} ${verdict} - ${step.content ?? ""}`);
    lines.push(`  check: ${step.verify?.trim() || "(none)"}`);
    for (const path of driftByStep.get(step.id) ?? []) lines.push(`  ⚠ drift: ${path}`);
  }
  for (const path of unattributedDrift) lines.push(`⚠ drift: ${path} (unattributed)`);
  // J1: plan-level gates (closure milestones, the refutation pass) were previously
  // invisible here — they have no step_id, so the per-step map skips them.
  const planGates = db.getGates(plan.id).filter((gate) => !gate.step_id);
  if (planGates.length > 0) {
    lines.push("plan gates:");
    for (const gate of planGates) {
      const display = gateVerdictFor(gate);
      const icon =
        display.outcome === "verified"
          ? "✓"
          : display.outcome === "failed" || display.outcome === "unrunnable"
            ? "✗"
            : "○";
      const tier = display.tier ? `${TIER_GLYPHS[display.tier]} ` : "";
      lines.push(`${icon} ${gate.kind ?? "milestone"} ${tier}${display.reason}`);
      for (const reason of gateReasons(gate).slice(0, 5)) lines.push(`  - ${reason}`);
    }
  }
  lines.push(...orphanLines(db, sessionId));
  return lines.join("\n");
}

/** Free-form reason bullets some gate writers store in factors (e.g. the refutation pass). */
function gateReasons(gate: GateRow): string[] {
  if (!gate.factors_json) return [];
  try {
    const raw = JSON.parse(gate.factors_json) as Record<string, unknown>;
    return Array.isArray(raw.reasons) ? raw.reasons.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Blocked attempts written before any plan existed (plan_id NULL) are reachable only by
 * session — surfaced in /why so a pre-plan red is never invisible. Reporting only: the
 * feedback join stays rec_id-scoped.
 */
function orphanLines(db: MinimaDb, sessionId: string): string[] {
  const orphans = db.getSessionOrphanGates(sessionId);
  if (orphans.length === 0) return [];
  const lines = ["⚠ unattributed blocked attempts (no plan existed at the time):"];
  for (const gate of orphans) {
    lines.push(`  ✗ ${gate.outcome ?? "?"} - ${flipContentOf(gate) ?? "(unknown step)"}`);
  }
  return lines;
}

function flipContentOf(gate: GateRow): string | null {
  if (!gate.factors_json) return null;
  try {
    const raw = JSON.parse(gate.factors_json) as Record<string, unknown>;
    return typeof raw.flipContent === "string" && raw.flipContent.trim()
      ? raw.flipContent.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a gate row to a {@link GateVerdict}. Prefers the tier Track A stamped onto the row; when
 * that column is empty (older rows, or a gate written before the reasoner ran) it recomputes the
 * tier from `factors_json` so tier→behavior decisions never silently fall back to "no verdict".
 */
export function gateVerdictFor(gate: GateRow | undefined): GateVerdict {
  if (!gate) return { outcome: null, tier: null, reason: "not verified" };
  const factors = parseFactors(gate.factors_json);
  if (factors) {
    const derived = confidence(factors);
    return { outcome: gate.outcome, tier: gate.confidence ?? derived.tier, reason: derived.reason };
  }
  if (gate.outcome === "failed" || gate.outcome === "unrunnable") {
    return { outcome: gate.outcome, tier: gate.confidence ?? "red", reason: "check did not pass" };
  }
  return {
    outcome: gate.outcome,
    tier: gate.confidence,
    reason: gate.outcome === "verified" ? "verification recorded" : "no verdict recorded",
  };
}

/**
 * Parse and structurally validate a `factors_json` blob into {@link Factors}, returning null when
 * the column is empty or malformed. Exported so tier→behavior wiring validates gates identically
 * to `/why` rather than trusting an unchecked `JSON.parse`.
 */
export function parseFactors(raw: string | null): Factors | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const factors = value as Record<string, unknown>;
  if (
    typeof factors.pass !== "boolean" ||
    typeof factors.redToGreen !== "boolean" ||
    typeof factors.hasCheck !== "boolean" ||
    !isCheckOrigin(factors.checkOrigin) ||
    (typeof factors.coverageHit !== "boolean" && factors.coverageHit !== "unknown") ||
    typeof factors.tamper !== "boolean" ||
    (factors.blind !== undefined && typeof factors.blind !== "boolean")
  ) {
    return null;
  }
  return factors as unknown as Factors;
}

function isCheckOrigin(value: unknown): value is CheckOrigin {
  return typeof value === "string" && CHECK_ORIGINS.some((origin) => origin === value);
}
