import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { gateConfidence } from "../src/minima/behavior.ts";
import { groundedOutcomeFor, stampGroundedOutcome } from "../src/minima/ground_truth.ts";
import type { Factors } from "../src/minima/gt_contract.ts";

// Week 3 Track B new seams: the M6.3 user_signals reader and the M7.1 grounded-outcome stamp.
// Both are hermetic against an in-memory MinimaDb.

const RED: Factors = {
  pass: false,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};
const GREEN: Factors = { ...RED, pass: true };

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

/** A run + one routing decision to stamp, mirroring runtime.persistDecision's output. */
function seedRun(d: MinimaDb, runId: string, recId: string) {
  d.ensureProject("proj");
  d.startRun({ runId, projectKey: "proj" });
  d.writeDecision({
    recId,
    runId,
    taskLabel: "t",
    chosenModel: "m",
    decisionBasis: "b",
    confidence: 0.5,
    thresholdUsed: 0.5,
    ranked: [],
    estCostUsd: 0,
    actualCostUsd: 0,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 1,
  });
}

describe("getUserSignals (M6.3 reader)", () => {
  test("returns the overrides recorded against a gate, oldest first", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    const gateId = d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      verifiedBy: "deterministic",
    });
    expect(d.getUserSignals(gateId)).toEqual([]);
    d.recordUserSignal(gateId, "accept");
    d.recordUserSignal(gateId, "steer");
    const rows = d.getUserSignals(gateId);
    expect(rows.map((r) => r.action)).toEqual(["accept", "steer"]);
    expect(rows.every((r) => r.gate_id === gateId)).toBe(true);
  });

  test("is empty for a gate that was never answered", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    const gateId = d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      verifiedBy: "deterministic",
    });
    expect(d.getUserSignals(gateId)).toEqual([]);
  });
});

describe("stampGroundedOutcome (M7.1)", () => {
  test("stamps the most recent gate's verdict onto the routing decision", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
    // Earlier green gate, then a later red gate — the red is the most recent verdict.
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
    });
    d.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
    });

    stampGroundedOutcome(d, "run1", "rec1");

    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec1")!;
    expect(dec.gt_outcome).toBe("failed");
    expect(dec.gt_verified_by).toBe("deterministic");
    expect(dec.gt_confidence).toBe("red");
  });

  test("no gates on the active plan → no-op (routing row left unstamped)", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    stampGroundedOutcome(d, "run1", "rec1");
    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec1")!;
    expect(dec.gt_outcome).toBeNull();
    expect(dec.gt_verified_by).toBeNull();
  });

  test("no active plan → no-op, no throw, routing row untouched", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    expect(() => stampGroundedOutcome(d, "run1", "rec1")).not.toThrow();
    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec1")!;
    expect(dec.gt_outcome).toBeNull();
  });

  test("fails open on a null db / session / recId (never throws)", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    expect(() => stampGroundedOutcome(null, "run1", "rec1")).not.toThrow();
    expect(() => stampGroundedOutcome(d, null, "rec1")).not.toThrow();
    expect(() => stampGroundedOutcome(d, "run1", null)).not.toThrow();
  });
});

describe("groundedOutcomeFor (M7.2/M7.3 shared reader)", () => {
  test("returns the most recent gate's verdict on the active plan", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
    });
    d.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
    });
    const g = groundedOutcomeFor(d, "run1");
    expect(g?.outcome).toBe("failed");
    expect(g?.verifiedBy).toBe("deterministic");
    expect(g?.confidence).toBe("red");
    expect(typeof g?.gateId).toBe("string");
  });

  test("null when there is no active plan / no gate / gate missing outcome or verifier", () => {
    const noPlan = db();
    expect(groundedOutcomeFor(noPlan, "run1")).toBeNull();

    const noGate = db();
    noGate.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(groundedOutcomeFor(noGate, "run1")).toBeNull();

    const noVerifier = db();
    const { planId, stepIds } = noVerifier.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    // A gate with an outcome but no verifier is not a grounded verdict yet.
    noVerifier.insertGate({ planId, stepId: stepIds[0]!, outcome: "verified" });
    expect(groundedOutcomeFor(noVerifier, "run1")).toBeNull();
  });

  test("fails open on null db / session (never throws)", () => {
    expect(groundedOutcomeFor(null, "run1")).toBeNull();
    expect(groundedOutcomeFor(db(), null)).toBeNull();
  });
});
