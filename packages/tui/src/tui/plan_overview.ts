/**
 * Plan Overview content model (U3, MUB-141) — pure, no React. The ledger is the source:
 * plans/plan_steps/gates/file_changes read at open time, per-step realized $ from the v8
 * routing_decisions.step_id stamp (stepCosts). A step's tier reduces through the same
 * gateVerdictFor as /why, so the sidebar and the report can never disagree about a gate.
 * stepCardLines is the shared per-step detail card that J1's /why view builds on (MUB-126).
 */

import stringWidth from "string-width";

import type { GateRow, MinimaDb } from "../db/minima_db.ts";
import type { ConfidenceTier } from "../minima/big_plan_contract.ts";
import { gateVerdictFor, parseFactors } from "../minima/why.ts";

const TIER_GLYPHS: Record<ConfidenceTier, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

const STATUS_GLYPHS: Record<string, string> = {
  pending: "⬜",
  in_progress: "🟦",
  completed: "✅",
};

export interface PlanOverviewStepRow {
  stepId: string;
  idx: number;
  content: string;
  /** ⬜/🟦/✅ from plan_steps.status (unknown → ⬜). */
  statusGlyph: string;
  /** 🟢/🟡/🔴 from the step's latest gate; null when never gated. */
  tierGlyph: string | null;
  tierReason: string | null;
  verify: string | null;
  verifyCwd: string | null;
  baseline: string | null;
  checkOrigin: string | null;
  driftPaths: string[];
  /** Realized $ from stamped decisions; null = no attribution (renders "—", not $0). */
  costUsd: number | null;
}

export interface PlanOverview {
  planId: string;
  title: string;
  /** 1-based position of the active step (first in_progress, else first not-completed,
   * else steps.length when all done — matching the footer strip); 0 only for an empty plan. */
  stepPos: number;
  stepTotal: number;
  steps: PlanOverviewStepRow[];
  driftCount: number;
  totalCostUsd: number;
  /** Latest gate rows per step, newest last — the detail card's evidence list. */
  gatesByStep: Map<string, GateRow[]>;
}

/** Read the active (else latest) plan into the overview model; null = no plan recorded. */
export function buildPlanOverview(db: MinimaDb, sessionId: string): PlanOverview | null {
  const plan =
    db.getActivePlan(sessionId) ?? db.getLatestPlan(sessionId, { excludeCancelled: true });
  if (!plan) return null;
  const steps = db.getPlanSteps(plan.id);
  const { perStep, totalUsd } = db.stepCosts(plan.id);

  const gatesByStep = new Map<string, GateRow[]>();
  for (const gate of db.getGates(plan.id)) {
    if (!gate.step_id) continue;
    const list = gatesByStep.get(gate.step_id) ?? [];
    list.push(gate);
    gatesByStep.set(gate.step_id, list);
  }

  const driftByStep = new Map<string, string[]>();
  let driftCount = 0;
  for (const change of db.getFileChanges(plan.id)) {
    if (change.origin !== "off_plan") continue;
    driftCount += 1;
    if (!change.step_id) continue;
    const paths = driftByStep.get(change.step_id) ?? [];
    paths.push(change.path);
    driftByStep.set(change.step_id, paths);
  }

  const rows: PlanOverviewStepRow[] = steps.map((step) => {
    const gates = gatesByStep.get(step.id) ?? [];
    const verdict = gateVerdictFor(gates[gates.length - 1]);
    return {
      stepId: step.id,
      idx: step.idx,
      content: step.content ?? "",
      statusGlyph: STATUS_GLYPHS[step.status ?? ""] ?? "⬜",
      tierGlyph: verdict.tier ? TIER_GLYPHS[verdict.tier] : null,
      tierReason: verdict.tier ? verdict.reason : null,
      verify: step.verify?.trim() || null,
      verifyCwd: step.verify_cwd,
      baseline: step.baseline,
      checkOrigin: step.check_origin,
      driftPaths: driftByStep.get(step.id) ?? [],
      costUsd: perStep.get(step.id) ?? null,
    };
  });

  // Mirrors big_plan.ts activeStepPos: first in-progress, else first not-yet-completed,
  // else the last (all done — "step N/N", never the contradictory "step 0/N"; MUB-173b).
  const active = steps.findIndex((s) => s.status === "in_progress");
  const firstOpen = steps.findIndex((s) => s.status !== "completed");
  const pos = active >= 0 ? active + 1 : firstOpen >= 0 ? firstOpen + 1 : steps.length;

  return {
    planId: plan.id,
    title: plan.title?.trim() || plan.id,
    stepPos: pos,
    stepTotal: steps.length,
    steps: rows,
    driftCount,
    totalCostUsd: totalUsd,
    gatesByStep,
  };
}

const fmtUsd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(4)}`);

/**
 * Clip to `width` DISPLAY columns (stringWidth) — unlike toc.ts's code-point fit, every U3
 * step row leads with two double-width emoji (status + tier), so a code-point clip would
 * overflow the panel border on all of them, not just the odd ⚙ title.
 */
function fit(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = "";
  let w = 0;
  for (const cp of text) {
    const cw = stringWidth(cp);
    if (w + cw > width - 1) break;
    out += cp;
    w += cw;
  }
  return `${out}…`;
}

/** Pad with spaces to exactly `width` display columns (padEnd counts UTF-16 units, not cells). */
export function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
}

export interface PlanOverviewPanelRow {
  text: string;
  /** Index into overview.steps; title rows are the cursor stops. */
  stepIdx: number | null;
  isTitle: boolean;
}

/** Flatten the overview into panel rows: header · per-step title/check/drift · Σ footer. */
export function planOverviewRows(
  overview: PlanOverview,
  innerWidth: number,
): PlanOverviewPanelRow[] {
  const rows: PlanOverviewPanelRow[] = [];
  rows.push({
    text: fit(`${overview.title} — step ${overview.stepPos}/${overview.stepTotal}`, innerWidth),
    stepIdx: null,
    isTitle: false,
  });
  if (overview.driftCount > 0) {
    rows.push({
      text: fit(`⚠ ${overview.driftCount} off-plan change(s) (DRIFT)`, innerWidth),
      stepIdx: null,
      isTitle: false,
    });
  }
  for (let i = 0; i < overview.steps.length; i++) {
    const s = overview.steps[i]!;
    const tier = s.tierGlyph ? ` ${s.tierGlyph}` : "";
    rows.push({
      text: fit(`${s.statusGlyph}${tier} ${s.idx + 1}. ${s.content}`, innerWidth),
      stepIdx: i,
      isTitle: true,
    });
    rows.push({
      text: fit(
        `     ${fmtUsd(s.costUsd)} · ${s.verify ? `✓ ${s.verify}` : "⚠ no verify"}`,
        innerWidth,
      ),
      stepIdx: i,
      isTitle: false,
    });
    for (const path of s.driftPaths) {
      rows.push({ text: fit(`     ⚠ drift: ${path}`, innerWidth), stepIdx: i, isTitle: false });
    }
  }
  rows.push({ text: "─".repeat(Math.max(1, innerWidth)), stepIdx: null, isTitle: false });
  rows.push({
    text: fit(`Σ ${fmtUsd(overview.totalCostUsd)} realized (stamped steps)`, innerWidth),
    stepIdx: null,
    isTitle: false,
  });
  return rows;
}

/**
 * Per-step detail card (Enter on a step) — the shared component J1's /why per-step view
 * reuses: check + provenance, gate history (outcome · tier · reason), drift, realized $.
 */
export function stepCardLines(row: PlanOverviewStepRow, gates: GateRow[]): string[] {
  const lines: string[] = [];
  lines.push(`${row.statusGlyph} step ${row.idx + 1} — ${row.content}`);
  lines.push(`check: ${row.verify ?? "(none)"}`);
  if (row.verifyCwd) lines.push(`cwd: ${row.verifyCwd}`);
  if (row.baseline) lines.push(`baseline: ${row.baseline}`);
  if (row.checkOrigin) lines.push(`check origin: ${row.checkOrigin}`);
  lines.push(`cost: ${fmtUsd(row.costUsd)}`);
  if (gates.length === 0) {
    lines.push("gates: (none — not verified)");
  } else {
    lines.push("gates:");
    for (const gate of gates) {
      const verdict = gateVerdictFor(gate);
      const tier = verdict.tier ? `${TIER_GLYPHS[verdict.tier]} ` : "";
      lines.push(`  ${tier}${gate.outcome ?? "?"} — ${verdict.reason}`);
      const evidence = redGreenEvidence(gate);
      if (evidence) lines.push(`    evidence: ${evidence}`);
    }
  }
  for (const path of row.driftPaths) lines.push(`⚠ drift: ${path}`);
  return lines;
}

/**
 * J1.1: the red→green story a gate's factors tell — the strongest evidence a check can
 * give. A pass with no captured red is honestly labeled pre-satisfied, never dressed up.
 */
function redGreenEvidence(gate: GateRow): string | null {
  const factors = parseFactors(gate.factors_json);
  if (!factors || !factors.pass) return null;
  return factors.redToGreen
    ? "red→green vs the captured baseline"
    : "green from the start (pre-satisfied — not proof of this change)";
}

/** One-shot text overview — the Ctrl+G output. */
export function renderPlanOverviewText(overview: PlanOverview | null, width: number): string {
  if (!overview) return "No Big Plan recorded for this run.";
  const lines = [
    `Plan Overview — ${overview.title} (step ${overview.stepPos}/${overview.stepTotal})`,
  ];
  if (overview.driftCount > 0) lines.push(`⚠ ${overview.driftCount} off-plan change(s) (DRIFT)`);
  for (const s of overview.steps) {
    const tier = s.tierGlyph ? ` ${s.tierGlyph}` : "";
    lines.push(fit(`${s.statusGlyph}${tier} ${s.idx + 1}. ${s.content}`, width));
    lines.push(
      fit(`     ${fmtUsd(s.costUsd)} · ${s.verify ? `✓ ${s.verify}` : "⚠ no verify"}`, width),
    );
    for (const path of s.driftPaths) lines.push(fit(`     ⚠ drift: ${path}`, width));
  }
  lines.push(fit(`Σ ${fmtUsd(overview.totalCostUsd)} realized (stamped steps)`, width));
  return lines.join("\n");
}
