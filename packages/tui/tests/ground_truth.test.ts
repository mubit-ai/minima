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
    ...over,
  };
}

const PLAN: PlanRow = { id: "p1", session_id: "s1", title: "My Plan", status: "active", created_at: null };

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
    expect(parseTodos([{ content: "A", status: "completed" }])).toEqual([{ content: "A", status: "completed" }]);
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
    expect(parseTodos(raw).map((t) => t.status)).toEqual(["pending", "in_progress", "completed", "pending"]);
  });

  test("never sources `verify` from the todowrite payload", () => {
    const out = parseTodos(JSON.stringify([{ content: "a", status: "pending", verify: "should-be-ignored" }]));
    expect(out[0]).toEqual({ content: "a", status: "pending" });
    expect(out[0]!.verify).toBeUndefined();
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
    const patch = ["*** Update File: dup.ts", "+x", "*** Update File: dup.ts", "not a header line"].join("\n");
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
    const out = formatPlanProjection({ ...PLAN, title: null }, [step({ idx: 0, content: "Only", status: "pending" })])!;
    expect(out).toContain("# Current plan (step 1/1)");
    expect(out).not.toContain("—");
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
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "pending", verify: "npm test" }]);
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    expect(d.getPlanSteps(planId)[0]!.verify).toBe("npm test");
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
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
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
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    d.setStepBaseline(stepIds[0]!, "red");
    d.setStepBaseline(stepIds[0]!, "green");
    expect(d.getPlanSteps(planId)[0]!.baseline).toBe("green");
  });

  test("a captured baseline survives a later todowrite upsert of the same step (COALESCE-independent column)", () => {
    const d = db();
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "pending" }]);
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

  test("todowrite with no valid todos creates no plan", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("todowrite", { tasks: "[]" }));
    expect(d.getActivePlan("run1")).toBeNull();
  });

  test("write on a claimed path is recorded on_plan against the in-progress step", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "Update config.ts loader", status: "in_progress" }]);
    const inProgress = d.getInProgressStep(planId)!;
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("write", { path: "src/minima/config.ts" }));
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
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "Update config.ts loader", status: "in_progress" }]);
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("edit", { path: "src/other/router.ts" }));
    const changes = d.getFileChanges(planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.origin).toBe("off_plan");
    expect(changes[0]!.kind).toBe("modified");
    expect(d.countOffPlanChanges(planId)).toBe(1);
  });

  test("write with a plan but no in-progress step attributes off_plan with a null step", async () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [{ content: "config.ts work", status: "pending" }]);
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("write", { path: "src/config.ts" }));
    const changes = d.getFileChanges(planId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.origin).toBe("off_plan");
    expect(changes[0]!.step_id).toBeNull();
  });

  test("write with no active plan records nothing", async () => {
    const d = db();
    await groundTruthAfterToolCall({ db: d, runId: "run1" })(ctx("write", { path: "src/config.ts" }));
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
