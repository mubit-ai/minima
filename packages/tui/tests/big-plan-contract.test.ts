import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  BASELINES,
  CHECK_ORIGINS,
  CONFIDENCE_TIERS,
  GATE_KINDS,
  GATE_OUTCOMES,
  USER_ACTIONS,
  VERIFIED_BY,
} from "../src/minima/big_plan_contract.ts";

// The Big Plan contract (docs §5b Step 0) is the frozen seam between the two build tracks.
// These tests lock the enum spellings (a rename breaks a test) and prove every value survives
// a verbatim round-trip through the DB boundary in db/minima_db.ts — so producer, consumer,
// and schema can never silently disagree.

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

describe("big_plan_contract frozen value sets", () => {
  test("enum spellings are frozen (regression guard)", () => {
    expect(GATE_OUTCOMES).toEqual(["verified", "failed", "unrunnable", "unchecked"]);
    expect(CONFIDENCE_TIERS).toEqual(["green", "yellow", "red"]);
    expect(VERIFIED_BY).toEqual(["deterministic", "judge", "user"]);
    expect(GATE_KINDS).toEqual(["step_check", "milestone", "stop", "recovery"]);
    expect(BASELINES).toEqual(["red", "green", "unrunnable"]);
    expect(USER_ACTIONS).toEqual(["accept", "reject", "steer"]);
    expect(CHECK_ORIGINS).toEqual(["pre_existing", "agent_new", "user"]);
  });
});

describe("big_plan_contract enums round-trip through the DB boundary", () => {
  test("every GateKind/GateOutcome/ConfidenceTier/VerifiedBy persists verbatim", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    for (const kind of GATE_KINDS)
      for (const outcome of GATE_OUTCOMES)
        for (const confidence of CONFIDENCE_TIERS)
          for (const verifiedBy of VERIFIED_BY)
            d.insertGate({
              planId,
              stepId: stepIds[0]!,
              kind,
              outcome,
              confidence,
              verifiedBy,
              factors: { pass: true },
            });

    const gates = d.getGates(planId);
    expect(gates.length).toBe(
      GATE_KINDS.length * GATE_OUTCOMES.length * CONFIDENCE_TIERS.length * VERIFIED_BY.length,
    );
    // The stored domains are exactly the frozen sets — nothing coerced or dropped.
    expect(new Set(gates.map((g) => g.kind))).toEqual(new Set(GATE_KINDS));
    expect(new Set(gates.map((g) => g.outcome))).toEqual(new Set(GATE_OUTCOMES));
    expect(new Set(gates.map((g) => g.confidence))).toEqual(new Set(CONFIDENCE_TIERS));
    expect(new Set(gates.map((g) => g.verified_by))).toEqual(new Set(VERIFIED_BY));
  });

  test("every Baseline persists on a step", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
      { content: "B", status: "pending" },
      { content: "C", status: "pending" },
    ]);
    BASELINES.forEach((b, i) => d.setStepBaseline(stepIds[i]!, b));
    expect(d.getPlanSteps(planId).map((s) => s.baseline)).toEqual([...BASELINES]);
  });

  test("every UserAction persists against a gate", () => {
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
    for (const action of USER_ACTIONS) d.recordUserSignal(gateId, action);
    const rows = d.db
      .query("SELECT action FROM user_signals WHERE gate_id = ? ORDER BY rowid")
      .all(gateId) as { action: string }[];
    expect(rows.map((r) => r.action)).toEqual([...USER_ACTIONS]);
  });

  test("verified-outcome enums stamp onto the routing decision (big_plan_* columns)", () => {
    const d = db();
    d.ensureProject("proj");
    const runId = d.startRun({ runId: "run1", projectKey: "proj" });
    d.writeDecision({
      recId: "rec1",
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
    d.attachBigPlanOutcome("rec1", {
      outcome: "verified",
      verifiedBy: "deterministic",
      confidence: "green",
    });
    const dec = d.getRunDecisions(runId).find((r) => r.rec_id === "rec1")!;
    expect(dec.big_plan_outcome).toBe("verified");
    expect(dec.big_plan_verified_by).toBe("deterministic");
    expect(dec.big_plan_confidence).toBe("green");
  });
});
