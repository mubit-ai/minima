import { describe, expect, test } from "bun:test";

import { MinimaDb } from "../src/db/minima_db.ts";
import { gateConfidence } from "../src/minima/behavior.ts";
import type { Factors } from "../src/minima/gt_contract.ts";
import {
  REFUTATION_STEP_ID,
  buildRefutationDelegation,
  parseRefutationVerdict,
  runPlanRefutation,
} from "../src/minima/plan_refute.ts";
import { whyReportFor } from "../src/minima/why.ts";
import type { ChildResult, Delegation, SpawnFn } from "../src/tools/task.ts";

const GREEN: Factors = {
  pass: true,
  redToGreen: true,
  hasCheck: true,
  checkOrigin: "pre_existing",
  coverageHit: true,
  tamper: false,
};

function seeded(): { db: MinimaDb; runId: string; planId: string; stepIds: string[] } {
  const db = new MinimaDb(":memory:");
  db.ensureProject("p");
  const runId = db.startRun({ projectKey: "p" });
  const { planId, stepIds } = db.upsertPlanFromTodos(
    runId,
    [
      { content: "wire endpoint", status: "completed", verify: "bun test endpoint" },
      { content: "ship docs", status: "completed" },
    ],
    "Ship it",
  );
  db.writeDecision({
    recId: "rec-last",
    runId,
    taskLabel: "t",
    chosenModel: "m",
    decisionBasis: "memory",
    confidence: 0.8,
    thresholdUsed: 0.7,
    ranked: [],
    estCostUsd: 0.01,
    actualCostUsd: 0.02,
    quality: null,
    judged: false,
    outcome: "success",
    turns: 1,
    latencyMs: 5,
  });
  return { db, runId, planId, stepIds };
}

const spawnReplying = (reply: string, outcome: ChildResult["outcome"] = "success"): SpawnFn => {
  return async (d: Delegation): Promise<ChildResult> => ({
    step_id: d.step_id,
    childId: "refuter-1",
    text: reply,
    costUsd: 0.03,
    quality: null,
    outcome,
    workdir: null,
  });
};

describe("buildRefutationDelegation (J1.2)", () => {
  test("no plan → null; brief carries steps, checks, gate history, drift, and read-only boundaries", () => {
    const empty = new MinimaDb(":memory:");
    empty.ensureProject("p");
    const emptyRun = empty.startRun({ projectKey: "p" });
    expect(buildRefutationDelegation(empty, emptyRun)).toBeNull();

    const { db, runId, planId, stepIds } = seeded();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "verified",
      confidence: gateConfidence(GREEN),
      verifiedBy: "deterministic",
      factors: GREEN,
      sessionId: runId,
    });
    db.insertFileChange({ planId, path: "src/stray.ts", origin: "off_plan" });

    const d = buildRefutationDelegation(db, runId);
    if (!d) throw new Error("expected delegation");
    expect(d.step_id).toBe(REFUTATION_STEP_ID);
    expect(d.objective).toContain("Ship it");
    expect(d.objective).toContain("bun test endpoint");
    expect(d.objective).toContain("verified");
    expect(d.objective).toContain("src/stray.ts");
    expect(d.objective).toContain("REFUTE");
    expect(d.boundaries).toContain("READ-ONLY");
    expect(d.output_format).toContain("VERDICT:");
    expect(d.difficulty).toBe("expert");
  });
});

describe("parseRefutationVerdict (fail-closed)", () => {
  test("confirmed, refuted with bullets, and garbled → refuted", () => {
    expect(
      parseRefutationVerdict("VERDICT: confirmed\nREASONS:\n- reran both checks").refuted,
    ).toBe(false);
    const refuted = parseRefutationVerdict(
      "VERDICT: refuted\nREASONS:\n- check 2 has no test\n- drift contradicts step 1",
    );
    expect(refuted.refuted).toBe(true);
    expect(refuted.reasons).toEqual(["check 2 has no test", "drift contradicts step 1"]);

    const garbled = parseRefutationVerdict("everything looks great to me!");
    expect(garbled.refuted).toBe(true);
    expect(garbled.reasons[0]).toContain("unparseable");
  });
});

describe("runPlanRefutation (J1.2 gate + gt_outcome feed)", () => {
  test("confirmed → judge-verified 🟡 milestone gate on the latest rec; gt_outcome stamped", async () => {
    const { db, runId, planId } = seeded();
    const outcome = await runPlanRefutation({
      db,
      sessionId: runId,
      spawn: spawnReplying("VERDICT: confirmed\nREASONS:\n- reran the endpoint check, green"),
    });
    if (!outcome) throw new Error("expected outcome");
    expect(outcome.recId).toBe("rec-last");

    const gate = db.getGates(planId).find((g) => g.id === outcome.gateId);
    if (!gate) throw new Error("gate row missing");
    expect(gate.kind).toBe("milestone");
    expect(gate.outcome).toBe("verified");
    expect(gate.verified_by).toBe("judge");
    expect(gate.confidence).toBe("yellow"); // judge-verified caps at 🟡 — never 🟢
    expect(gate.step_id).toBeNull();
    expect(gate.rec_id).toBe("rec-last");

    const dec = db.getRunDecisions(runId).at(-1)!;
    expect(dec.gt_outcome).toBe("verified");
    expect(dec.gt_verified_by).toBe("judge");
    expect(dec.gt_confidence).toBe("yellow");

    // J1.1: the plan-level gate is visible in /why.
    const report = whyReportFor(db, runId);
    expect(report).toContain("plan gates:");
    expect(report).toContain("milestone");
  });

  test("refuted → red failed gate; reasons surface in /why", async () => {
    const { db, runId, planId } = seeded();
    const outcome = await runPlanRefutation({
      db,
      sessionId: runId,
      spawn: spawnReplying("VERDICT: refuted\nREASONS:\n- step 2 has no check at all"),
    });
    if (!outcome) throw new Error("expected outcome");
    const gate = db.getGates(planId).find((g) => g.id === outcome.gateId)!;
    expect(gate.outcome).toBe("failed");
    expect(gate.confidence).toBe("red");
    expect(db.getRunDecisions(runId).at(-1)!.gt_outcome).toBe("failed");
    expect(whyReportFor(db, runId)).toContain("step 2 has no check at all");
  });

  test("a deterministic red step gate still outranks a confirmed refutation on the same rec", async () => {
    const { db, runId, planId, stepIds } = seeded();
    db.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      confidence: "red",
      verifiedBy: "deterministic",
      factors: { ...GREEN, pass: false },
      recId: "rec-last",
      sessionId: runId,
    });
    await runPlanRefutation({
      db,
      sessionId: runId,
      spawn: spawnReplying("VERDICT: confirmed\nREASONS:\n- looked fine"),
    });
    const dec = db.getRunDecisions(runId).at(-1)!;
    expect(dec.gt_outcome).toBe("failed"); // red wins the identity join
    expect(dec.gt_confidence).toBe("red");
  });

  test("aborted child → null, no gate row (never a fabricated verdict)", async () => {
    const { db, runId, planId } = seeded();
    const before = db.getGates(planId).length;
    const outcome = await runPlanRefutation({
      db,
      sessionId: runId,
      spawn: spawnReplying("whatever", "aborted"),
    });
    expect(outcome).toBeNull();
    expect(db.getGates(planId).length).toBe(before);
  });

  test("spawn throwing → fail-closed refuted gate", async () => {
    const { db, runId, planId } = seeded();
    const outcome = await runPlanRefutation({
      db,
      sessionId: runId,
      spawn: async () => {
        throw new Error("provider exploded");
      },
    });
    if (!outcome) throw new Error("expected fail-closed outcome");
    expect(outcome.verdict.refuted).toBe(true);
    const gate = db.getGates(planId).find((g) => g.id === outcome.gateId)!;
    expect(gate.outcome).toBe("failed");
    expect(gate.confidence).toBe("red");
  });
});
