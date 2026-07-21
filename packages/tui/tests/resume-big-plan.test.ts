import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { planStripInfo } from "../src/minima/big_plan.ts";
import { whyReportFor } from "../src/minima/why.ts";

// GT101-F4: resuming a run must re-key the old run's still-active plan onto the resuming run
// (MOVE semantics) so sticky verify/baselines, the projection, and the done-gate survive —
// without adoption the old plan stays 'active' under a dead run forever and the gate is
// silently bypassed. Old-run session-keyed gate rows are deliberately NOT adopted.

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

describe("MinimaDb.adoptActivePlans (resume)", () => {
  test("moves the active plan and everything plan_id-keyed follows", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("old-run", [
      { content: "A", status: "in_progress", verify: "exit 1" },
      { content: "B", status: "pending" },
    ]);
    d.setStepBaseline(stepIds[0]!, "red");
    d.insertGate({
      planId,
      stepId: stepIds[0]!,
      outcome: "failed",
      verifiedBy: "deterministic",
      recId: "rec-old",
      sessionId: "old-run",
    });

    expect(d.adoptActivePlans("old-run", "new-run")).toBe(1);

    const adopted = d.getActivePlan("new-run")!;
    expect(adopted.id).toBe(planId);
    expect(d.getActivePlan("old-run")).toBeNull();
    // Sticky verify/baseline survive: the done-gate still previews the red step.
    const flips = d.completionsForTodos("new-run", [
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
    ]);
    expect(flips).toEqual([
      {
        content: "A",
        stepId: stepIds[0]!,
        verify: "exit 1",
        baseline: "red",
        verify_cwd: null,
        check_origin: null,
      },
    ]);
    // The projection points at the adopted plan.
    expect(planStripInfo(d, "new-run")?.stepTotal).toBe(2);
    expect(planStripInfo(d, "old-run")).toBeNull();
  });

  test("done plans are not adopted; nothing to adopt returns 0", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("old-run", [{ content: "A", status: "completed" }]);
    d.setPlanStatus(planId, "done");
    expect(d.adoptActivePlans("old-run", "new-run")).toBe(0);
    expect(d.getActivePlan("new-run")).toBeNull();
    expect(d.adoptActivePlans("ghost-run", "new-run")).toBe(0);
  });

  test("the old run's session-keyed gates stay behind (no verdict leakage)", () => {
    const d = db();
    d.upsertPlanFromTodos("old-run", [{ content: "A", status: "in_progress" }]);
    d.insertGate({
      planId: null,
      stepId: null,
      outcome: "failed",
      verifiedBy: "deterministic",
      factors: { flipContent: "pre-plan attempt" },
      recId: "rec-old",
      sessionId: "old-run",
    });
    d.adoptActivePlans("old-run", "new-run");
    expect(d.getSessionOrphanGates("old-run")).toHaveLength(1);
    expect(d.getSessionOrphanGates("new-run")).toHaveLength(0);
  });
});

describe("whyReportFor: unattributed blocked attempts", () => {
  test("plan-less blocked attempts surface in /why for their session", () => {
    const d = db();
    d.insertGate({
      planId: null,
      stepId: null,
      outcome: "failed",
      verifiedBy: "deterministic",
      factors: { flipContent: "ship the fix" },
      recId: "rec-1",
      sessionId: "run1",
    });
    const report = whyReportFor(d, "run1");
    expect(report).toContain("unattributed blocked attempts");
    expect(report).toContain("ship the fix");
  });

  test("with a plan present the orphan section appends after the steps", () => {
    const d = db();
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    d.insertGate({
      planId: null,
      stepId: null,
      outcome: "unrunnable",
      verifiedBy: "deterministic",
      recId: "rec-1",
      sessionId: "run1",
    });
    const report = whyReportFor(d, "run1");
    expect(report).toContain("step 1");
    expect(report).toContain("unattributed blocked attempts");
    expect(report).toContain("(unknown step)");
  });

  test("no orphans → no section", () => {
    const d = db();
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(whyReportFor(d, "run1")).not.toContain("unattributed blocked attempts");
  });
});
