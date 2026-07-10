import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import { confidence } from "./confidence.ts";
import { CHECK_ORIGINS } from "./gt_contract.ts";
import type { CheckOrigin, ConfidenceTier, Factors } from "./gt_contract.ts";

const TIER_GLYPHS: Record<ConfidenceTier, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

interface GateDisplay {
  outcome: GateRow["outcome"];
  tier: ConfidenceTier | null;
  reason: string;
}

export function whyReportFor(db: MinimaDb | null, sessionId: string | null): string {
  if (!db || !sessionId) return "No Ground-Truth ledger available.";
  const plan = db.getLatestPlan(sessionId);
  if (!plan) return "No Ground-Truth plan recorded for this run.";

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

  const lines = [`Ground-Truth verification - ${plan.title?.trim() || plan.id}`];
  if (steps.length === 0) lines.push("No plan steps recorded.");
  for (const step of steps) {
    const gate = latestGateByStep.get(step.id);
    const display = gateDisplay(gate);
    const icon = display.outcome === "verified" ? "✓" : display.outcome ? "✗" : "○";
    const verdict = display.tier
      ? `${TIER_GLYPHS[display.tier]} ${display.reason}`
      : display.reason;
    lines.push(`${icon} step ${step.idx + 1} ${verdict} - ${step.content ?? ""}`);
    lines.push(`  check: ${step.verify?.trim() || "(none)"}`);
    for (const path of driftByStep.get(step.id) ?? []) lines.push(`  ⚠ drift: ${path}`);
  }
  for (const path of unattributedDrift) lines.push(`⚠ drift: ${path} (unattributed)`);
  return lines.join("\n");
}

function gateDisplay(gate: GateRow | undefined): GateDisplay {
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

function parseFactors(raw: string | null): Factors | null {
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
    typeof factors.tamper !== "boolean"
  ) {
    return null;
  }
  return factors as unknown as Factors;
}

function isCheckOrigin(value: unknown): value is CheckOrigin {
  return typeof value === "string" && CHECK_ORIGINS.some((origin) => origin === value);
}
