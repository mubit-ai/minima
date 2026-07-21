import { describe, expect, test } from "bun:test";
import { MinimaDb } from "../src/db/minima_db.ts";
import { parseTodos } from "../src/minima/big_plan.ts";
import { parseStepTools } from "../src/minima/tool_permissions.ts";

// A6 — plan_steps.tools persistence: seeded, authored via todowrite, and sticky like verify.

function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

const toolsOf = (d: MinimaDb, planId: string, idx = 0): string[] | null =>
  parseStepTools(d.getPlanSteps(planId)[idx]!.tools);

describe("seedPlanFromSteps tools", () => {
  test("seeds the per-step allowlist as JSON", () => {
    const d = db();
    const { planId } = d.seedPlanFromSteps("run1", "T", [
      { content: "Edit router", verify: "bun test x", tools: ["edit", "bash"] },
      { content: "Scaffold", verify: null, tools: null },
    ]);
    expect(toolsOf(d, planId, 0)).toEqual(["edit", "bash"]);
    expect(toolsOf(d, planId, 1)).toBeNull();
  });
});

describe("upsertPlanFromTodos tools stickiness", () => {
  test("sets, keeps on omit, overwrites on resend — never clears", () => {
    const d = db();
    // 1. author tools
    d.upsertPlanFromTodos("run1", [
      { content: "Edit router", status: "in_progress", tools: ["edit"] },
    ]);
    const planId = d.getActivePlan("run1")!.id;
    expect(toolsOf(d, planId)).toEqual(["edit"]);

    // 2. omit tools → sticky (COALESCE keeps the existing allowlist)
    d.upsertPlanFromTodos("run1", [{ content: "Edit router", status: "in_progress" }]);
    expect(toolsOf(d, planId)).toEqual(["edit"]);

    // 3. resend with a new set → overwrites
    d.upsertPlanFromTodos("run1", [
      { content: "Edit router", status: "in_progress", tools: ["edit", "bash"] },
    ]);
    expect(toolsOf(d, planId)).toEqual(["edit", "bash"]);

    // 4. an empty array is treated as "omit" (serializes to NULL) → cannot clear
    d.upsertPlanFromTodos("run1", [{ content: "Edit router", status: "in_progress", tools: [] }]);
    expect(toolsOf(d, planId)).toEqual(["edit", "bash"]);
  });
});

describe("parseTodos tools", () => {
  test("carries a tools allowlist; omits the key when absent/empty", () => {
    const todos = parseTodos(
      JSON.stringify([
        { content: "a", status: "in_progress", tools: ["edit", " bash "] },
        { content: "b", status: "pending" },
        { content: "c", status: "pending", tools: [] },
      ]),
    );
    expect(todos[0]!.tools).toEqual(["edit", "bash"]);
    expect(todos[1]!.tools).toBeUndefined();
    expect(todos[2]!.tools).toBeUndefined(); // empty → omitted (sticky)
  });
});
