/**
 * Plan-delegated steps: the schema that carries a delegation's result and cost, the
 * projection from a plan step to a Delegation, the budget slice math, and the one-attempt
 * guard. Hermetic: temp DB only, nothing spawns here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimaDb } from "../src/db/minima_db.ts";

let dir: string;
let db: MinimaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minima-plandel-"));
  db = new MinimaDb(join(dir, "t.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  test("a step carries its delegation result, cost and agent type", () => {
    const { planId, stepIds } = db.seedPlanFromSteps("sess-1", "T", [
      { content: "step one", verify: "bun test a", agentType: "reviewer" },
      { content: "step two", verify: "bun test b" },
    ]);
    const before = db.getPlanSteps(planId);
    expect(before[0]!.agent_type).toBe("reviewer");
    expect(before[1]!.agent_type).toBeNull();
    expect(before[0]!.result).toBeNull();
    expect(before[0]!.delegated_cost_usd).toBeNull();

    db.recordStepDelegation(stepIds[0]!, "did the thing", 0.0123);
    const after = db.getPlanSteps(planId);
    expect(after[0]!.result).toBe("did the thing");
    expect(after[0]!.delegated_cost_usd!).toBeCloseTo(0.0123, 6);
  });

  test("planDelegatedSpend sums only what was actually delegated", () => {
    const { planId, stepIds } = db.seedPlanFromSteps("sess-2", "T", [
      { content: "a" },
      { content: "b" },
      { content: "c" },
    ]);
    expect(db.planDelegatedSpend(planId)).toBe(0);
    db.recordStepDelegation(stepIds[0]!, "x", 0.1);
    db.recordStepDelegation(stepIds[1]!, "y", 0.25);
    expect(db.planDelegatedSpend(planId)).toBeCloseTo(0.35, 6);
  });

  test("a failed delegation still stamps cost — that is the one-attempt marker", () => {
    const { planId, stepIds } = db.seedPlanFromSteps("sess-3", "T", [{ content: "a" }]);
    db.recordStepDelegation(stepIds[0]!, "error: boom", 0);
    expect(db.getPlanSteps(planId)[0]!.delegated_cost_usd).toBe(0);
  });

  test("the plan budget round-trips and is null until set", () => {
    const { planId } = db.seedPlanFromSteps("sess-4", "T", [{ content: "a" }]);
    expect(db.getPlanBudget(planId)).toBeNull();
    db.setPlanBudget(planId, 2.5);
    expect(db.getPlanBudget(planId)).toBeCloseTo(2.5, 6);
    db.setPlanBudget(planId, null);
    expect(db.getPlanBudget(planId)).toBeNull();
  });
});
