import { describe, expect, test } from "bun:test";
import type { DecisionWrite } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { gateConfidence } from "../src/minima/behavior.ts";
import type { Factors } from "../src/minima/gt_contract.ts";
import {
  buildGtOverview,
  gtRows,
  renderGtOverviewText,
  stepCardLines,
} from "../src/tui/gt_overview.ts";

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};
const YELLOW: Factors = { ...GREEN, checkOrigin: "agent_new" };
const RED: Factors = { ...GREEN, pass: false };

function seededDb(): { db: MinimaDb; runId: string; planId: string; stepIds: string[] } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  const { planId, stepIds } = db.upsertPlanFromTodos(
    runId,
    [
      { content: "add auth model", status: "completed", verify: "bun test auth" },
      { content: "write login handler", status: "completed", verify: "bun test login" },
      { content: "integrate billing", status: "in_progress", verify: "bun test billing" },
      { content: "ship docs", status: "pending" },
    ],
    "Checkout",
  );
  return { db, runId, planId, stepIds };
}

function decision(
  overrides: Partial<DecisionWrite> & { recId: string; runId: string },
): DecisionWrite {
  return {
    taskLabel: "t",
    chosenModel: "m",
    decisionBasis: "estimate",
    confidence: 0.5,
    thresholdUsed: 0.5,
    ranked: [],
    estCostUsd: 0.01,
    actualCostUsd: 0,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 10,
    ...overrides,
  };
}

describe("stepCosts + v8 step_id stamp (U3.2)", () => {
  test("realized $ groups by stamped step; unstamped steps absent from the map", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.writeDecision(decision({ recId: "r1", runId, stepId: stepIds[0], actualCostUsd: 0.02 }));
    db.writeDecision(decision({ recId: "r2", runId, stepId: stepIds[0], actualCostUsd: 0.03 }));
    db.writeDecision(decision({ recId: "r3", runId, stepId: stepIds[2], actualCostUsd: 0.1 }));
    db.writeDecision(decision({ recId: "r4", runId, actualCostUsd: 5 })); // unattributed
    const { perStep, totalUsd } = db.stepCosts(planId);
    expect(perStep.get(stepIds[0]!)).toBeCloseTo(0.05);
    expect(perStep.get(stepIds[2]!)).toBeCloseTo(0.1);
    expect(perStep.has(stepIds[1]!)).toBe(false);
    expect(totalUsd).toBeCloseTo(0.15);
  });

  test("feedback-time rewrite (no stepId) never clears the routing-time stamp", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.writeDecision(decision({ recId: "r1", runId, stepId: stepIds[0], actualCostUsd: 0.02 }));
    // The feedback path upserts the same rec_id with realized cost but no step context.
    db.writeDecision(decision({ recId: "r1", runId, actualCostUsd: 0.07 }));
    const { perStep } = db.stepCosts(planId);
    expect(perStep.get(stepIds[0]!)).toBeCloseTo(0.07);
  });

  test("steps of another run's plan never leak into the aggregation", () => {
    const { db, planId } = seededDb();
    const otherRun = db.startRun({ projectKey: "p" });
    const other = db.upsertPlanFromTodos(otherRun, [{ content: "x", status: "pending" }], "Other");
    db.writeDecision(
      decision({ recId: "r1", runId: otherRun, stepId: other.stepIds[0], actualCostUsd: 1 }),
    );
    expect(db.stepCosts(planId).totalUsd).toBe(0);
  });
});

describe("buildGtOverview (U3.1)", () => {
  test("no plan → null; renderGtOverviewText says so", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    expect(buildGtOverview(db, runId)).toBeNull();
    expect(renderGtOverviewText(null, 80)).toContain("No Ground-Truth plan");
  });

  test("statuses, tiers, verify, drift, cost and stepPos reduce from the ledger", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    db.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "verified",
      confidence: gateConfidence(YELLOW),
      verifiedBy: "deterministic",
      factors: YELLOW,
      sessionId: runId,
    });
    db.insertGate({
      planId,
      stepId: stepIds[2]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
      sessionId: runId,
    });
    db.insertFileChange({ planId, stepId: stepIds[2]!, path: "src/rogue.ts", origin: "off_plan" });
    db.insertFileChange({ planId, path: "src/stray.ts", origin: "off_plan" });
    db.writeDecision(decision({ recId: "r1", runId, stepId: stepIds[2], actualCostUsd: 0.25 }));

    const o = buildGtOverview(db, runId);
    if (!o) throw new Error("expected overview");
    expect(o.title).toBe("Checkout");
    expect(o.stepTotal).toBe(4);
    expect(o.stepPos).toBe(3); // in_progress step wins
    expect(o.driftCount).toBe(2);
    expect(o.steps.map((s) => s.statusGlyph)).toEqual(["✅", "✅", "🟦", "⬜"]);
    expect(o.steps[0]!.tierGlyph).toBe("🟢");
    expect(o.steps[1]!.tierGlyph).toBe("🟡");
    expect(o.steps[2]!.tierGlyph).toBe("🔴");
    expect(o.steps[3]!.tierGlyph).toBeNull();
    expect(o.steps[2]!.driftPaths).toEqual(["src/rogue.ts"]);
    expect(o.steps[2]!.costUsd).toBeCloseTo(0.25);
    expect(o.steps[0]!.costUsd).toBeNull();
    expect(o.steps[3]!.verify).toBeNull();
  });

  test("all-pending plan → stepPos is the first pending step", () => {
    const db = new MinimaDb(":memory:");
    db.ensureProject("p");
    const runId = db.startRun({ projectKey: "p" });
    db.upsertPlanFromTodos(runId, [{ content: "a", status: "pending" }], "T");
    const o = buildGtOverview(db, runId);
    expect(o?.stepPos).toBe(1);
  });
});

describe("gtRows / stepCardLines / renderGtOverviewText (U3.1 + U3.3)", () => {
  test("panel rows: header, no-verify warning, — for unstamped cost, Σ footer", () => {
    const { db, runId } = seededDb();
    const o = buildGtOverview(db, runId);
    if (!o) throw new Error("expected overview");
    const rows = gtRows(o, 60);
    expect(rows[0]!.text).toContain("Checkout — step 3/4");
    const texts = rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("⚠ no verify"))).toBe(true);
    expect(texts.some((t) => t.includes("— · ✓ bun test auth"))).toBe(true);
    expect(texts[texts.length - 1]).toContain("Σ");
    // Cursor stops are exactly the step titles.
    expect(rows.filter((r) => r.isTitle).length).toBe(4);
  });

  test("detail card: check + gate history; ungated step reads 'not verified'", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    const o = buildGtOverview(db, runId);
    if (!o) throw new Error("expected overview");
    const gated = stepCardLines(o.steps[0]!, o.gatesByStep.get(o.steps[0]!.stepId) ?? []);
    expect(gated[0]).toContain("step 1 — add auth model");
    expect(gated).toContain("check: bun test auth");
    expect(gated.some((l) => l.includes("🟢") && l.includes("verified"))).toBe(true);
    const ungated = stepCardLines(o.steps[3]!, []);
    expect(ungated).toContain("gates: (none — not verified)");
  });

  test("every panel row fits innerWidth in DISPLAY columns (double-width emoji lead rows)", async () => {
    const { default: stringWidth } = await import("string-width");
    const { db, runId, planId, stepIds } = seededDb();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    const o = buildGtOverview(db, runId);
    if (!o) throw new Error("expected overview");
    for (const width of [20, 38]) {
      for (const row of gtRows(o, width)) {
        expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("J1.1: gate evidence lines — red→green vs honest pre-satisfied", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    db.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "verified",
      confidence: gateConfidence({ ...GREEN, redToGreen: false }),
      verifiedBy: "deterministic",
      factors: { ...GREEN, redToGreen: false },
      sessionId: runId,
    });
    const o = buildGtOverview(db, runId);
    if (!o) throw new Error("expected overview");
    const flipped = stepCardLines(o.steps[0]!, o.gatesByStep.get(o.steps[0]!.stepId) ?? []);
    expect(flipped.some((l) => l.includes("red→green vs the captured baseline"))).toBe(true);
    const preSat = stepCardLines(o.steps[1]!, o.gatesByStep.get(o.steps[1]!.stepId) ?? []);
    expect(preSat.some((l) => l.includes("pre-satisfied"))).toBe(true);
  });

  test("one-shot text render carries steps, tiers and the Σ line", () => {
    const { db, runId, planId, stepIds } = seededDb();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    const o = buildGtOverview(db, runId);
    const text = renderGtOverviewText(o, 100);
    expect(text).toContain("GT plan — Checkout (step 3/4)");
    expect(text).toContain("🟢");
    expect(text).toContain("Σ");
  });
});
