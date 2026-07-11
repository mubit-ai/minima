import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { gateConfidence } from "../src/minima/behavior.ts";
import { groundedOutcomeFor, stampGroundedOutcome } from "../src/minima/ground_truth.ts";
import type { Factors } from "../src/minima/gt_contract.ts";

// Week 3 Track B seams under the v6 identity join: the M6.3 user_signals reader and the M7.1
// grounded-outcome stamp. Grounded verdicts are scoped to ONE routed rung by gates.rec_id —
// recency and plan state no longer matter. Hermetic against an in-memory MinimaDb.

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
  test("returns the overrides recorded against a gate, oldest first, with notes", () => {
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
    d.recordUserSignal(gateId, "steer", "try the integration suite instead");
    const rows = d.getUserSignals(gateId);
    expect(rows.map((r) => r.action)).toEqual(["accept", "steer"]);
    expect(rows.map((r) => r.note)).toEqual([null, "try the integration suite instead"]);
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

describe("stampGroundedOutcome (M7.1, identity join)", () => {
  test("stamps the verdict of the gates minted under the rec — red wins over green", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
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
      recId: "rec1",
      sessionId: "run1",
    });
    d.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
      recId: "rec1",
      sessionId: "run1",
    });

    stampGroundedOutcome(d, "rec1");

    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec1")!;
    expect(dec.gt_outcome).toBe("failed");
    expect(dec.gt_verified_by).toBe("deterministic");
    expect(dec.gt_confidence).toBe("red");
  });

  test("gates minted under ANOTHER rec never stamp this decision (stale-gate immunity)", () => {
    const d = db();
    seedRun(d, "run1", "rec2");
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
      recId: "rec1",
      sessionId: "run1",
    });
    stampGroundedOutcome(d, "rec2");
    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec2")!;
    expect(dec.gt_outcome).toBeNull();
    expect(dec.gt_verified_by).toBeNull();
  });

  test("pre-identity gate rows (NULL rec_id) are invisible to every rec", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
    });
    stampGroundedOutcome(d, "rec1");
    const dec = d.getRunDecisions("run1").find((r) => r.rec_id === "rec1")!;
    expect(dec.gt_outcome).toBeNull();
  });

  test("fails open on a null db / recId (never throws)", () => {
    const d = db();
    seedRun(d, "run1", "rec1");
    expect(() => stampGroundedOutcome(null, "rec1")).not.toThrow();
    expect(() => stampGroundedOutcome(d, null)).not.toThrow();
  });
});

describe("groundedOutcomeFor (M7.2/M7.3 shared reader, identity join)", () => {
  test("aggregates the rec's gates: any red wins regardless of insert order", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "failed",
      confidence: gateConfidence(RED),
      verifiedBy: "deterministic",
      factors: RED,
      recId: "rec1",
    });
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      recId: "rec1",
    });
    const g = groundedOutcomeFor(d, "rec1");
    expect(g?.outcome).toBe("failed");
    expect(g?.verifiedBy).toBe("deterministic");
    expect(g?.confidence).toBe("red");
    expect(typeof g?.gateId).toBe("string");
  });

  test("a later same-flip verdict supersedes an orphan blocked attempt (retry heals the red)", () => {
    // The blocked attempt of a brand-new todo has step_id NULL (the refused call never ran the
    // upsert) — only its flipContent links it to the retry's verdict, which resolved a step id.
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "ship the fix", status: "completed" },
    ]);
    d.insertGate({
      planId: null,
      stepId: null,
      outcome: "failed",
      verifiedBy: "deterministic",
      factors: { ...RED, flipContent: "ship the fix" },
      recId: "rec1",
    });
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      verifiedBy: "deterministic",
      factors: { ...GREEN, flipContent: "ship the fix" },
      recId: "rec1",
    });
    const g = groundedOutcomeFor(d, "rec1");
    expect(g?.outcome).toBe("verified");
  });

  test("an unchecked completion caps the tier at yellow (vip needs every flip verified green)", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "completed" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      verifiedBy: "deterministic",
      factors: { ...GREEN, flipContent: "A" },
      recId: "rec1",
    });
    d.insertGate({
      planId,
      stepId: stepIds[1]!,
      outcome: "unchecked",
      verifiedBy: null,
      factors: { ...GREEN, pass: false, hasCheck: false, flipContent: "B" },
      recId: "rec1",
    });
    const g = groundedOutcomeFor(d, "rec1");
    expect(g?.outcome).toBe("verified");
    expect(g?.confidence).toBe("yellow");
  });

  test("all flips verified green → green", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "completed" },
    ]);
    for (const [i, content] of (["A", "B"] as const).entries()) {
      d.insertGate({
        planId,
        stepId: stepIds[i]!,
        outcome: "verified",
        verifiedBy: "deterministic",
        factors: { ...GREEN, flipContent: content },
        recId: "rec1",
      });
    }
    expect(groundedOutcomeFor(d, "rec1")?.confidence).toBe("green");
  });

  test("only unchecked rows → null (no deterministic evidence; the judge path runs)", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
    ]);
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "unchecked",
      verifiedBy: null,
      factors: { ...GREEN, pass: false, hasCheck: false, flipContent: "A" },
      recId: "rec1",
    });
    expect(groundedOutcomeFor(d, "rec1")).toBeNull();
  });

  test("null when the rec has no gates / gate missing outcome or verifier", () => {
    const empty = db();
    expect(groundedOutcomeFor(empty, "rec1")).toBeNull();

    const noVerifier = db();
    const { planId, stepIds } = noVerifier.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    noVerifier.insertGate({ planId, stepId: stepIds[0]!, outcome: "verified", recId: "rec1" });
    expect(groundedOutcomeFor(noVerifier, "rec1")).toBeNull();
  });

  test("fails open on null db / recId (never throws)", () => {
    expect(groundedOutcomeFor(null, "rec1")).toBeNull();
    expect(groundedOutcomeFor(db(), null)).toBeNull();
  });
});
