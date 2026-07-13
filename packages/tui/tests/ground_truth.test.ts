import { describe, expect, test } from "bun:test";
import type { AfterToolCallContext } from "../src/agent/tools.ts";
import type { PlanRow, PlanStepRow } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import {
  formatPlanProjection,
  groundTruthAfterToolCall,
  isPathClaimed,
  kindForTool,
  parseTodos,
  pathsFromPatch,
  planProjectionFor,
  planStripDrift,
  planStripInfo,
  planStripLabel,
  writePathsFromArgs,
} from "../src/minima/ground_truth.ts";

// --------------------------------------------------------------------------- helpers

/** A fresh in-memory ledger per test — no shared state, no disk. */
function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

/** Build a minimal AfterToolCall context — the sink only reads name/arguments/isError. */
function ctx(name: string, args: Record<string, unknown>, isError = false): AfterToolCallContext {
  return {
    toolCall: { type: "toolCall", id: "tc", name, arguments: args },
    isError,
  } as unknown as AfterToolCallContext;
}

function step(over: Partial<PlanStepRow> & { idx: number }): PlanStepRow {
  return {
    id: `s${over.idx}`,
    plan_id: "p1",
    content: null,
    status: "pending",
    verify: null,
    baseline: null,
    created_at: null,
    verify_cwd: null,
    check_origin: null,
    ...over,
  };
}

const PLAN: PlanRow = {
  id: "p1",
  session_id: "s1",
  title: "My Plan",
  status: "active",
  created_at: null,
};

// --------------------------------------------------------------------------- parseTodos

describe("parseTodos", () => {
  test("parses a JSON string of todo objects", () => {
    const raw = JSON.stringify([
      { content: "First", status: "in_progress" },
      { content: "Second", status: "pending" },
    ]);
    expect(parseTodos(raw)).toEqual([
      { content: "First", status: "in_progress" },
      { content: "Second", status: "pending" },
    ]);
  });

  test("accepts an already-parsed array", () => {
    expect(parseTodos([{ content: "A", status: "completed" }])).toEqual([
      { content: "A", status: "completed" },
    ]);
  });

  test("returns [] on malformed JSON", () => {
    expect(parseTodos("{not json")).toEqual([]);
  });

  test("returns [] for non-array inputs", () => {
    expect(parseTodos({ content: "x", status: "pending" })).toEqual([]);
    expect(parseTodos(42)).toEqual([]);
    expect(parseTodos(null)).toEqual([]);
    expect(parseTodos(undefined)).toEqual([]);
  });

  test("skips entries with empty/whitespace content and trims", () => {
    const raw = JSON.stringify([
      { content: "  ", status: "pending" },
      { content: "", status: "pending" },
      { content: "  real  ", status: "pending" },
      null,
      "string-entry",
    ]);
    expect(parseTodos(raw)).toEqual([{ content: "real", status: "pending" }]);
  });

  test("normalizes unknown statuses to pending, preserves in_progress/completed", () => {
    const raw = JSON.stringify([
      { content: "a", status: "weird" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d" },
    ]);
    expect(parseTodos(raw).map((t) => t.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
      "pending",
    ]);
  });

  test("sources verify from the todowrite payload (M3.1)", () => {
    const out = parseTodos(
      JSON.stringify([
        { content: "a", status: "pending", verify: "bun test tests/a.test.ts" },
        { content: "b", status: "pending", verify: "   " },
        { content: "c", status: "pending", verify: 42 },
        { content: "d", status: "pending", verify: "  bun run check  " },
        { content: "e", status: "pending" },
      ]),
    );
    expect(out[0]).toEqual({ content: "a", status: "pending", verify: "bun test tests/a.test.ts" });
    expect(out[1]).toEqual({ content: "b", status: "pending" });
    expect(out[2]).toEqual({ content: "c", status: "pending" });
    expect(out[3]).toEqual({ content: "d", status: "pending", verify: "bun run check" });
    expect(out[4]).toEqual({ content: "e", status: "pending" });
    expect("verify" in out[1]!).toBe(false);
    expect("verify" in out[2]!).toBe(false);
    expect("verify" in out[4]!).toBe(false);
  });
});

// --------------------------------------------------------------------------- pathsFromPatch

describe("pathsFromPatch", () => {
  test("extracts Add/Update/Delete File targets", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/a.ts",
      "+contents",
      "*** Update File: src/b.ts",
      "@@",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");
    expect(pathsFromPatch(patch)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("dedups repeated targets and ignores non-envelope lines", () => {
    const patch = [
      "*** Update File: dup.ts",
      "+x",
      "*** Update File: dup.ts",
      "not a header line",
    ].join("\n");
    expect(pathsFromPatch(patch)).toEqual(["dup.ts"]);
  });

  test("returns [] for an empty/headerless patch", () => {
    expect(pathsFromPatch("")).toEqual([]);
    expect(pathsFromPatch("just some diff text")).toEqual([]);
  });
});

// --------------------------------------------------------------------------- writePathsFromArgs

describe("writePathsFromArgs", () => {
  test("write/edit return the trimmed path", () => {
    expect(writePathsFromArgs("write", { path: "  foo.ts " })).toEqual(["foo.ts"]);
    expect(writePathsFromArgs("edit", { path: "bar.ts" })).toEqual(["bar.ts"]);
  });

  test("write/edit return [] for missing/blank/non-string path", () => {
    expect(writePathsFromArgs("write", {})).toEqual([]);
    expect(writePathsFromArgs("write", { path: "   " })).toEqual([]);
    expect(writePathsFromArgs("edit", { path: 123 })).toEqual([]);
  });

  test("apply_patch delegates to the patch parser", () => {
    const patch = "*** Add File: x.ts\n+1";
    expect(writePathsFromArgs("apply_patch", { patch })).toEqual(["x.ts"]);
    expect(writePathsFromArgs("apply_patch", {})).toEqual([]);
  });

  test("unknown tools contribute no paths", () => {
    expect(writePathsFromArgs("bash", { path: "foo.ts" })).toEqual([]);
    expect(writePathsFromArgs("todowrite", { tasks: "[]" })).toEqual([]);
  });
});

// --------------------------------------------------------------------------- kindForTool

describe("kindForTool", () => {
  test("write creates, everything else modifies", () => {
    expect(kindForTool("write")).toBe("created");
    expect(kindForTool("edit")).toBe("modified");
    expect(kindForTool("apply_patch")).toBe("modified");
  });
});

// --------------------------------------------------------------------------- isPathClaimed

describe("isPathClaimed", () => {
  test("false for empty step content or path", () => {
    expect(isPathClaimed(null, "a.ts")).toBe(false);
    expect(isPathClaimed(undefined, "a.ts")).toBe(false);
    expect(isPathClaimed("", "a.ts")).toBe(false);
    expect(isPathClaimed("do the thing", "")).toBe(false);
  });

  test("true when the step mentions the full path (case-insensitive)", () => {
    expect(isPathClaimed("Edit SRC/Config.ts to add a flag", "src/config.ts")).toBe(true);
  });

  test("true when the step mentions only the basename", () => {
    expect(isPathClaimed("Update the config.ts loader", "src/minima/config.ts")).toBe(true);
  });

  test("false when neither full path nor basename appears", () => {
    expect(isPathClaimed("Write the router logic", "src/other/thing.ts")).toBe(false);
  });
});

// --------------------------------------------------------------------------- formatPlanProjection

describe("formatPlanProjection", () => {
  test("returns null for an empty step list", () => {
    expect(formatPlanProjection(PLAN, [])).toBeNull();
  });

  test("numbers steps with x / > / space marks and a header", () => {
    const steps = [
      step({ idx: 0, content: "First", status: "completed" }),
      step({ idx: 1, content: "Second", status: "in_progress" }),
      step({ idx: 2, content: "Third", status: "pending" }),
    ];
    const out = formatPlanProjection(PLAN, steps)!;
    expect(out).toContain("# Current plan (step 2/3 — My Plan)");
    expect(out).toContain("1. [x] First");
    expect(out).toContain("2. [>] Second");
    expect(out).toContain("3. [ ] Third");
    expect(out).toContain("todowrite");
  });

  test("omits the title suffix when the plan has no title", () => {
    const out = formatPlanProjection({ ...PLAN, title: null }, [
      step({ idx: 0, content: "Only", status: "pending" }),
    ])!;
    const header = out.split("\n")[0]!;
    expect(header).toBe("# Current plan (step 1/1)");
    expect(header).not.toContain("—"); // no `— <title>` suffix in the header
  });

  test("renders the verify hint on steps that carry one (M3.1)", () => {
    const steps = [
      step({ idx: 0, content: "First", status: "in_progress", verify: "bun test tests/a.test.ts" }),
      step({ idx: 1, content: "Second", status: "pending" }),
    ];
    const out = formatPlanProjection(PLAN, steps)!;
    expect(out).toContain("1. [>] First — verify: `bun test tests/a.test.ts`");
    expect(out).toContain("2. [ ] Second");
  });

  test("a not-yet-done verify-less step gets the decompose nudge (state-backed, nudge-only)", () => {
    const out = formatPlanProjection(PLAN, [step({ idx: 0, content: "Only", status: "pending" })])!;
    const lines = out.split("\n");
    expect(lines[1]).toBe("1. [ ] Only — ⚠ no verify (decompose or add a check)");
    expect(out).not.toContain("verify: `");
  });

  test("a completed verify-less step is NOT nudged (past the point of nudging)", () => {
    const out = formatPlanProjection(PLAN, [
      step({ idx: 0, content: "Done", status: "completed" }),
    ])!;
    const lines = out.split("\n");
    expect(lines[1]).toBe("1. [x] Done");
    expect(out).not.toContain("no verify");
  });

  test("a step with a verify shows the check, not the nudge", () => {
    const out = formatPlanProjection(PLAN, [
      step({ idx: 0, content: "First", status: "pending", verify: "bun test" }),
    ])!;
    expect(out).toContain("1. [ ] First — verify: `bun test`");
    expect(out).not.toContain("no verify");
  });
});

// --------------------------------------------------------------------------- active-step selection

describe("active step selection (via formatPlanProjection header)", () => {
  const posOf = (steps: PlanStepRow[]) => {
    const out = formatPlanProjection(PLAN, steps)!;
    return out.match(/step (\d+)\//)![1];
  };

  test("prefers the first in_progress step", () => {
    expect(
      posOf([
        step({ idx: 0, status: "completed" }),
        step({ idx: 1, status: "in_progress" }),
        step({ idx: 2, status: "pending" }),
      ]),
    ).toBe("2");
  });

  test("falls back to the first not-completed step", () => {
    expect(
      posOf([step({ idx: 0, status: "completed" }), step({ idx: 1, status: "pending" })]),
    ).toBe("2");
  });

  test("falls back to the last step when all are completed", () => {
    expect(
      posOf([step({ idx: 0, status: "completed" }), step({ idx: 1, status: "completed" })]),
    ).toBe("2");
  });
});

// --------------------------------------------------------------------------- upsertPlanFromTodos

describe("MinimaDb.upsertPlanFromTodos", () => {
  test("creates a plan + steps and defaults the title to the first todo", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "Alpha", status: "in_progress" },
      { content: "Beta", status: "pending" },
    ]);
    const plan = d.getActivePlan("run1")!;
    expect(plan.id).toBe(planId);
    expect(plan.title).toBe("Alpha");
    const steps = d.getPlanSteps(planId);
    expect(steps.map((s) => s.content)).toEqual(["Alpha", "Beta"]);
    expect(stepIds).toHaveLength(2);
  });

  test("reuses the active plan and keeps step ids stable across calls", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "Alpha", status: "in_progress" },
      { content: "Beta", status: "pending" },
    ]);
    const second = d.upsertPlanFromTodos("run1", [
      { content: "Alpha", status: "completed" },
      { content: "Beta", status: "in_progress" },
    ]);
    expect(second.planId).toBe(first.planId);
    expect(second.stepIds).toEqual(first.stepIds);
    expect(d.getPlanSteps(first.planId).map((s) => s.status)).toEqual(["completed", "in_progress"]);
  });

  test("drops trailing steps when the list shrinks", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
      { content: "C", status: "pending" },
    ]);
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(planId).map((s) => s.content)).toEqual(["A"]);
  });

  test("preserves an existing verify via COALESCE when a later call omits it", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "pending", verify: "npm test" },
    ]);
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(planId)[0]!.verify).toBe("npm test");
  });

  test("started is [] on a pure-pending upsert (M3.3)", () => {
    const d = db();
    const { started } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "pending" },
      { content: "B", status: "pending", verify: "true" },
    ]);
    expect(started).toEqual([]);
  });

  test("started reports a pending→in_progress flip with the COALESCE'd effective verify (M3.3)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "pending", verify: "npm test" },
    ]);
    expect(first.started).toEqual([]);
    const second = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(second.started).toEqual([
      { id: first.stepIds[0]!, verify: "npm test", verify_cwd: null },
    ]);
  });

  test("started excludes already-in_progress steps and steps that already have a baseline (M3.3)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
      { content: "B", status: "pending", verify: "true" },
    ]);
    expect(first.started).toEqual([{ id: first.stepIds[0]!, verify: "true", verify_cwd: null }]);
    const again = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
      { content: "B", status: "pending" },
    ]);
    expect(again.started).toEqual([]);
    d.setStepBaseline(first.stepIds[1]!, "red");
    const flipped = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ]);
    expect(flipped.started).toEqual([]);
  });

  test("started includes fresh in_progress inserts, verify null when absent (M3.3)", () => {
    const d = db();
    const { started, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "bun test" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
    ]);
    expect(started).toEqual([
      { id: stepIds[0]!, verify: "bun test", verify_cwd: null },
      { id: stepIds[1]!, verify: null, verify_cwd: null },
    ]);
  });

  test("matches steps by content: verify and baseline follow a step across a prepend", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "Fix parser test", status: "pending", verify: "bun test parser" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "red");
    const second = d.upsertPlanFromTodos("run1", [
      { content: "Upgrade dep", status: "in_progress" },
      { content: "Fix parser test", status: "pending" },
    ]);
    const steps = d.getPlanSteps(first.planId);
    expect(steps.map((s) => s.content)).toEqual(["Upgrade dep", "Fix parser test"]);
    expect(steps[0]!.verify).toBeNull();
    expect(steps[0]!.baseline).toBeNull();
    expect(steps[1]!.id).toBe(first.stepIds[0]!);
    expect(steps[1]!.verify).toBe("bun test parser");
    expect(steps[1]!.baseline).toBe("red");
    expect(second.started).toEqual([{ id: second.stepIds[0]!, verify: null, verify_cwd: null }]);
  });

  test("a reorder keeps identity: the new occupant of an idx never inherits a baseline", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "task A", status: "in_progress", verify: "exit 1" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "red");
    d.upsertPlanFromTodos("run1", [
      { content: "task B", status: "in_progress", verify: "true" },
      { content: "task A", status: "completed" },
    ]);
    const steps = d.getPlanSteps(first.planId);
    expect(steps.map((s) => s.content)).toEqual(["task B", "task A"]);
    expect(steps[0]!.verify).toBe("true");
    expect(steps[0]!.baseline).toBeNull();
    expect(steps[1]!.id).toBe(first.stepIds[0]!);
    expect(steps[1]!.status).toBe("completed");
    expect(steps[1]!.baseline).toBe("red");
  });

  test("a reworded step keeps its identity: verify/baseline survive the new wording (fuzzy match)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "Fix parser", status: "pending", verify: "bun test parser" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "red");
    const second = d.upsertPlanFromTodos("run1", [
      { content: "Fix the parser", status: "pending" },
    ]);
    const steps = d.getPlanSteps(first.planId);
    expect(steps).toHaveLength(1);
    expect(second.stepIds[0]).toBe(first.stepIds[0]!);
    expect(steps[0]!.content).toBe("Fix the parser");
    expect(steps[0]!.verify).toBe("bun test parser");
    expect(steps[0]!.baseline).toBe("red");
  });

  test("a genuinely different step still re-enters fresh (below the fuzzy threshold)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "Fix parser", status: "pending", verify: "bun test parser" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "red");
    const second = d.upsertPlanFromTodos("run1", [
      { content: "Write the deployment docs", status: "pending" },
    ]);
    const steps = d.getPlanSteps(first.planId);
    expect(steps).toHaveLength(1);
    expect(second.stepIds[0]).not.toBe(first.stepIds[0]);
    expect(steps[0]!.verify).toBeNull();
    expect(steps[0]!.baseline).toBeNull();
  });

  test("started reports an in_progress step gaining its first verify, once-only (M3.3)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(first.started).toEqual([{ id: first.stepIds[0]!, verify: null, verify_cwd: null }]);
    const second = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    expect(second.started).toEqual([{ id: first.stepIds[0]!, verify: "true", verify_cwd: null }]);
    d.setStepBaseline(first.stepIds[0]!, "green");
    const resend = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    expect(resend.started).toEqual([]);
  });

  test("a CHANGED verify resets the baseline and re-reports the step for capture", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "green");
    // Swapping the check invalidates the old baseline: red→green must be scoped to the
    // check that produced the red, never credited to a different command.
    const swapped = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "exit 1" },
    ]);
    expect(swapped.started).toEqual([
      { id: first.stepIds[0]!, verify: "exit 1", verify_cwd: null },
    ]);
    expect(d.getPlanSteps(first.planId)[0]!.baseline).toBeNull();
    expect(d.getPlanSteps(first.planId)[0]!.verify).toBe("exit 1");
  });

  test("dropping a step with recorded file_changes detaches them instead of throwing (FK-safe)", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
      { content: "B", status: "pending" },
    ]);
    d.insertFileChange({
      planId: first.planId,
      stepId: first.stepIds[1]!,
      path: "b.ts",
      kind: "modified",
      origin: "on_plan",
    });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(first.planId)).toHaveLength(1);
    const changes = d.getFileChanges(first.planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.step_id).toBeNull();
  });
});

// --------------------------------------------------------------------------- MinimaDb.setStepBaseline (M3.3)

describe("MinimaDb.setStepBaseline", () => {
  test("baseline is null on a freshly upserted step", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(planId)[0]!.baseline).toBeNull();
  });

  test("records the captured baseline, readable via getPlanSteps", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    d.setStepBaseline(stepIds[0]!, "red");
    expect(d.getPlanSteps(planId)[0]!.baseline).toBe("red");
  });

  test("accepts red/green/unrunnable and keeps each step independent", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
    ]);
    d.setStepBaseline(stepIds[0]!, "green");
    d.setStepBaseline(stepIds[1]!, "red");
    d.setStepBaseline(stepIds[2]!, "unrunnable");
    expect(d.getPlanSteps(planId).map((s) => s.baseline)).toEqual(["green", "red", "unrunnable"]);
  });

  test("overwrites a prior baseline on re-capture (red → green)", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress" },
    ]);
    d.setStepBaseline(stepIds[0]!, "red");
    d.setStepBaseline(stepIds[0]!, "green");
    expect(d.getPlanSteps(planId)[0]!.baseline).toBe("green");
  });

  test("a captured baseline survives a later todowrite upsert of the same step (COALESCE-independent column)", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "pending" },
    ]);
    d.setStepBaseline(stepIds[0]!, "red");
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(planId)[0]!.baseline).toBe("red");
  });

  test("no-op on an unknown step id (never throws)", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(() => d.setStepBaseline("does-not-exist", "red")).not.toThrow();
    expect(d.getPlanSteps(planId)[0]!.baseline).toBeNull();
  });
});

// --------------------------------------------------------------------------- planProjectionFor / planStripInfo

describe("planProjectionFor", () => {
  test("returns null without a db or session", () => {
    expect(planProjectionFor(null, "run1")).toBeNull();
    expect(planProjectionFor(db(), null)).toBeNull();
  });

  test("returns null when the session has no active plan", () => {
    expect(planProjectionFor(db(), "run1")).toBeNull();
  });

  test("projects the persisted active plan", () => {
    const d = db();
    d.upsertPlanFromTodos("run1", [
      { content: "Write loader", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);
    const out = planProjectionFor(d, "run1")!;
    expect(out).toContain("1. [>] Write loader");
    expect(out).toContain("2. [ ] Add tests");
  });
});

describe("planStripInfo", () => {
  test("returns null without a db, session, or plan", () => {
    expect(planStripInfo(null, "run1")).toBeNull();
    expect(planStripInfo(db(), null)).toBeNull();
    expect(planStripInfo(db(), "run1")).toBeNull();
  });

  test("reports position, total, active title, and drift count", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "Edit config.ts", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);
    d.insertFileChange({ planId, path: "src/unrelated.ts", kind: "created", origin: "off_plan" });
    const info = planStripInfo(d, "run1")!;
    expect(info.stepPos).toBe(1);
    expect(info.stepTotal).toBe(2);
    expect(info.title).toBe("Edit config.ts");
    expect(info.drift).toBe(1);
  });
});

// --------------------------------------------------------------------------- footer strip formatters (M1.3/M2.3)

describe("planStripLabel / planStripDrift", () => {
  test("label renders `▸ plan pos/total — title` from the strip facts", () => {
    expect(planStripLabel({ stepPos: 2, stepTotal: 5, title: "Wire the router", drift: 0 })).toBe(
      "▸ plan 2/5 — Wire the router",
    );
  });

  test("label is total on an empty title (no trailing text beyond the em dash)", () => {
    expect(planStripLabel({ stepPos: 1, stepTotal: 1, title: "", drift: 0 })).toBe("▸ plan 1/1 — ");
  });

  test("drift suffix renders `⚠ N off-plan (drift)` with leading spaces when N > 0", () => {
    expect(planStripDrift(3)).toBe("   ⚠ 3 off-plan (drift)");
  });

  test("drift suffix is empty for zero (and never negative) so the caller renders nothing", () => {
    expect(planStripDrift(0)).toBe("");
    expect(planStripDrift(-1)).toBe("");
  });

  test("label + drift compose exactly as the footer <Text> concatenates them", () => {
    const info = { stepPos: 1, stepTotal: 2, title: "Edit config.ts", drift: 2 };
    const line = planStripLabel(info) + planStripDrift(info.drift);
    expect(line).toBe("▸ plan 1/2 — Edit config.ts   ⚠ 2 off-plan (drift)");
  });

  // The footer reserves exactly one row for the strip, but step content may carry interior
  // newlines — the label collapses them so the strip is provably one rendered row.
  test("label collapses interior newlines in the title to single spaces", () => {
    const label = planStripLabel({
      stepPos: 2,
      stepTotal: 5,
      title: "Wire the router\nand the judge",
      drift: 0,
    });
    expect(label).toBe("▸ plan 2/5 — Wire the router and the judge");
    expect(label).not.toContain("\n");
  });

  test("label collapses \\r\\n and newline runs with surrounding indentation", () => {
    expect(planStripLabel({ stepPos: 1, stepTotal: 1, title: "a\r\n  b\n\nc", drift: 0 })).toBe(
      "▸ plan 1/1 — a b c",
    );
  });

  test("newline-free titles render byte-identically (regression pin)", () => {
    expect(planStripLabel({ stepPos: 2, stepTotal: 5, title: "Wire the router", drift: 0 })).toBe(
      "▸ plan 2/5 — Wire the router",
    );
  });

  test("round-trip: the label sanitizes the projection while the DB content stays verbatim", () => {
    const d = db();
    const todos = parseTodos(
      JSON.stringify([{ content: "Wire the router\nand the judge", status: "in_progress" }]),
    );
    const { planId } = d.upsertPlanFromTodos("run1", todos);
    expect(d.getPlanSteps(planId)[0]!.content).toBe("Wire the router\nand the judge");
    const label = planStripLabel(planStripInfo(d, "run1")!);
    expect(label).not.toContain("\n");
    expect(label).toBe("▸ plan 1/1 — Wire the router and the judge");
  });
});

// --------------------------------------------------------------------------- groundTruthAfterToolCall (sink)

describe("groundTruthAfterToolCall", () => {
  test("no-ops when db or runId is missing", async () => {
    await expect(
      groundTruthAfterToolCall({ db: null, runId: "run1" })(ctx("todowrite", { tasks: "[]" })),
    ).resolves.toBeNull();
    await expect(
      groundTruthAfterToolCall({ db: db(), runId: null })(ctx("todowrite", { tasks: "[]" })),
    ).resolves.toBeNull();
  });

  test("ignores errored tool calls", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("todowrite", { tasks: JSON.stringify([{ content: "A", status: "pending" }]) }, true),
    );
    expect(d.getActivePlan("run1")).toBeNull();
  });

  test("todowrite upserts the plan of record", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("todowrite", {
        tasks: JSON.stringify([
          { content: "Alpha", status: "in_progress" },
          { content: "Beta", status: "pending" },
        ]),
      }),
    );
    const plan = d.getActivePlan("run1")!;
    expect(plan).not.toBeNull();
    expect(d.getPlanSteps(plan.id).map((s) => s.content)).toEqual(["Alpha", "Beta"]);
  });

  test("round-trips verify: todowrite → ledger, preserved when a later call omits it (M3.1)", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await sink(
      ctx("todowrite", {
        tasks: JSON.stringify([
          { content: "Alpha", status: "in_progress", verify: "bun test tests/a.test.ts" },
        ]),
      }),
    );
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.verify).toBe("bun test tests/a.test.ts");
    await sink(
      ctx("todowrite", { tasks: JSON.stringify([{ content: "Alpha", status: "completed" }]) }),
    );
    const steps = d.getPlanSteps(plan.id);
    expect(steps[0]!.status).toBe("completed");
    expect(steps[0]!.verify).toBe("bun test tests/a.test.ts");
  });

  test("todowrite with no valid todos creates no plan", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("todowrite", { tasks: "[]" }));
    expect(d.getActivePlan("run1")).toBeNull();
  });

  test("write on a claimed path is recorded on_plan against the in-progress step", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "Update config.ts loader", status: "in_progress" },
    ]);
    const inProgress = d.getInProgressStep(planId)!;
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("write", { path: "src/minima/config.ts" }),
    );
    const changes = d.getFileChanges(planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.origin).toBe("on_plan");
    expect(changes[0]!.kind).toBe("created");
    expect(changes[0]!.path).toBe("src/minima/config.ts");
    expect(changes[0]!.step_id).toBe(inProgress.id);
    expect(d.countOffPlanChanges(planId)).toBe(0);
  });

  test("write on an unclaimed path is recorded off_plan (drift)", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "Update config.ts loader", status: "in_progress" },
    ]);
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("edit", { path: "src/other/router.ts" }),
    );
    const changes = d.getFileChanges(planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.origin).toBe("off_plan");
    expect(changes[0]!.kind).toBe("modified");
    expect(d.countOffPlanChanges(planId)).toBe(1);
  });

  test("write with a plan but no in-progress step attributes off_plan with a null step", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "config.ts work", status: "pending" },
    ]);
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("write", { path: "src/config.ts" }),
    );
    const changes = d.getFileChanges(planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.origin).toBe("off_plan");
    expect(changes[0]!.step_id).toBeNull();
  });

  test("write with no active plan records nothing", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(
      ctx("write", { path: "src/config.ts" }),
    );
    // No plan means no plan id to query against; assert via a freshly-created plan being empty.
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "x", status: "pending" }]);
    expect(d.getFileChanges(planId)).toHaveLength(0);
  });

  test("non-write tools record no file changes", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "x", status: "in_progress" }]);
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("bash", { command: "ls" }));
    expect(d.getFileChanges(planId)).toHaveLength(0);
  });

  test("fail-open: a throwing ledger never propagates", async () => {
    const throwingDb = {
      getActivePlan() {
        throw new Error("boom");
      },
      upsertPlanFromTodos() {
        throw new Error("boom");
      },
    } as unknown as MinimaDb;
    const sink = groundTruthAfterToolCall({ db: throwingDb, runId: "run1" });
    await expect(
      sink(ctx("todowrite", { tasks: JSON.stringify([{ content: "A", status: "pending" }]) })),
    ).resolves.toBeNull();
    await expect(sink(ctx("write", { path: "a.ts" }))).resolves.toBeNull();
  });
});

// --------------------------------------------------------------------------- baseline capture (M3.3)

describe("baseline capture (M3.3)", () => {
  /** Send a todo list through the sink as a todowrite call. */
  const send = (sink: ReturnType<typeof groundTruthAfterToolCall>, todos: unknown[]) =>
    sink(ctx("todowrite", { tasks: JSON.stringify(todos) }));

  test("pending→in_progress flip runs the verify: failing check records red", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "pending", verify: "exit 1" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBeNull();
    await send(sink, [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
  });

  test("pending→in_progress flip with a passing check records green", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "pending", verify: "true" }]);
    await send(sink, [{ content: "A", status: "in_progress" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("green");
  });

  test("a new step inserted directly as in_progress gets its baseline captured", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "in_progress", verify: "true" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("green");
  });

  test("baseline is captured once-only for the SAME verify; a resend never re-runs", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "in_progress", verify: "exit 1" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
    await send(sink, [{ content: "A", status: "pending" }]);
    await send(sink, [{ content: "A", status: "in_progress", verify: "exit 1" }]);
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
  });

  test("a CHANGED verify recaptures the baseline against the new check", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "in_progress", verify: "exit 1" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
    await send(sink, [{ content: "A", status: "in_progress", verify: "true" }]);
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("green");
  });

  test("a verify-less flip leaves the baseline null (no check to run)", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "pending" }]);
    await send(sink, [{ content: "A", status: "in_progress" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBeNull();
  });

  test("fail-open: a throwing setStepBaseline never propagates", async () => {
    const real = db();
    const faked = {
      upsertPlanFromTodos: real.upsertPlanFromTodos.bind(real),
      setStepBaseline() {
        throw new Error("boom");
      },
    } as unknown as MinimaDb;
    const sink = groundTruthAfterToolCall({ db: faked, runId: "run1" });
    await expect(
      send(sink, [{ content: "A", status: "in_progress", verify: "true" }]),
    ).resolves.toBeNull();
    const plan = real.getActivePlan("run1")!;
    expect(real.getPlanSteps(plan.id)[0]!.baseline).toBeNull();
  });

  test("attaching a verify to an already-in_progress step still captures its baseline", async () => {
    const d = db();
    const sink = groundTruthAfterToolCall({ db: d, runId: "run1" });
    await send(sink, [{ content: "A", status: "in_progress" }]);
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBeNull();
    await send(sink, [{ content: "A", status: "in_progress", verify: "exit 1" }]);
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
  });

  test("per-step fail-open: one throwing setStepBaseline does not starve the remaining steps", async () => {
    const real = db();
    let calls = 0;
    const faked = {
      upsertPlanFromTodos: real.upsertPlanFromTodos.bind(real),
      setStepBaseline(...args: Parameters<MinimaDb["setStepBaseline"]>) {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        real.setStepBaseline(...args);
      },
    } as unknown as MinimaDb;
    const sink = groundTruthAfterToolCall({ db: faked, runId: "run1" });
    await expect(
      send(sink, [
        { content: "A", status: "in_progress", verify: "true" },
        { content: "B", status: "in_progress", verify: "exit 1" },
      ]),
    ).resolves.toBeNull();
    const plan = real.getActivePlan("run1")!;
    const steps = real.getPlanSteps(plan.id);
    expect(steps[0]!.baseline).toBeNull();
    expect(steps[1]!.baseline).toBe("red");
  });
});
