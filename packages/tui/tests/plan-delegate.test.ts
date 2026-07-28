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
import type { PlanStepRow } from "../src/db/minima_db.ts";
import {
  PRIOR_RESULTS_CAP_CHARS,
  buildStepDelegation,
  priorResultsFor,
  synthesizeBoundaries,
} from "../src/minima/plan_delegate.ts";

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

function row(over: Partial<PlanStepRow> & { id: string; idx: number }): PlanStepRow {
  return {
    plan_id: "p1",
    content: `step ${over.idx}`,
    status: "pending",
    verify: null,
    baseline: null,
    created_at: null,
    verify_cwd: null,
    check_origin: null,
    tools: null,
    candidates: null,
    result: null,
    delegated_cost_usd: null,
    agent_type: null,
    ...over,
  };
}

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

describe("projection", () => {
  test("prior results are completed steps only, most recent first", () => {
    const steps = [
      row({ id: "s1", idx: 0, status: "completed", result: "found the seam" }),
      row({ id: "s2", idx: 1, status: "completed", result: "wired it up" }),
      row({ id: "s3", idx: 2, status: "in_progress" }),
      row({ id: "s4", idx: 3, status: "pending" }),
    ];
    const priors = priorResultsFor(steps);
    expect(priors.map((p) => p.step_id)).toEqual(["s2", "s1"]);
    expect(priors[0]!.text).toBe("wired it up");
    expect(priors[0]!.outcome).toBe("success");
  });

  test("a completed step with no stored result is skipped, not passed as empty", () => {
    const steps = [
      row({ id: "s1", idx: 0, status: "completed", result: null }),
      row({ id: "s2", idx: 1, status: "completed", result: "real output" }),
    ];
    expect(priorResultsFor(steps).map((p) => p.step_id)).toEqual(["s2"]);
  });

  test("the cap bounds the projection — uncapped it would grow with plan length", () => {
    const steps = Array.from({ length: 40 }, (_, i) =>
      row({ id: `s${i}`, idx: i, status: "completed", result: "x".repeat(500) }),
    );
    const priors = priorResultsFor(steps);
    const total = priors.reduce((a, p) => a + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(PRIOR_RESULTS_CAP_CHARS);
    expect(priors.length).toBeGreaterThan(0);
    expect(priors[0]!.step_id).toBe("s39");
  });

  test("boundaries name the other steps' territory", () => {
    const steps = [
      row({ id: "s1", idx: 0, content: "add the parser" }),
      row({ id: "s2", idx: 1, content: "wire the CLI" }),
      row({ id: "s3", idx: 2, content: "write the docs" }),
    ];
    const b = synthesizeBoundaries(steps, "s2");
    expect(b).toContain("add the parser");
    expect(b).toContain("write the docs");
    expect(b).not.toContain("wire the CLI");
  });

  test("a single-step plan still produces usable boundaries", () => {
    const steps = [row({ id: "s1", idx: 0, content: "do it all" })];
    expect(synthesizeBoundaries(steps, "s1").length).toBeGreaterThan(0);
  });

  test("the delegation carries the step's own scope and the synthesized contract", () => {
    const steps = [
      row({ id: "s1", idx: 0, status: "completed", result: "prior" }),
      row({
        id: "s2",
        idx: 1,
        status: "in_progress",
        content: "wire the CLI",
        verify: "bun test tests/cli.test.ts",
        tools: JSON.stringify(["read", "edit", "bash"]),
        candidates: JSON.stringify(["gemini-2.5-flash"]),
        agent_type: "reviewer",
      }),
    ];
    const d = buildStepDelegation(steps, steps[1]!, 0.5);
    expect(d.step_id).toBe("s2");
    expect(d.objective).toBe("wire the CLI");
    expect(d.tool_allowlist).toEqual(["read", "edit", "bash"]);
    expect(d.candidates).toEqual(["gemini-2.5-flash"]);
    expect(d.agent_type).toBe("reviewer");
    expect(d.budget_usd).toBe(0.5);
    expect(d.depends_on).toEqual(["s1"]);
    expect(d.output_format).toContain("bun test tests/cli.test.ts");
    expect(d.boundaries).toContain("step 0");
    // A worktree child's writes go opaque and cap the plan at yellow — never isolate.
    expect(d.isolation).toBeUndefined();
  });

  test("a step with no tools/candidates/type delegates unrestricted", () => {
    const steps = [row({ id: "s1", idx: 0, content: "do it", status: "in_progress" })];
    const d = buildStepDelegation(steps, steps[0]!, 1);
    expect(d.tool_allowlist).toBeUndefined();
    expect(d.candidates).toBeUndefined();
    expect(d.agent_type).toBeUndefined();
    expect(d.depends_on).toEqual([]);
  });

  test("a verify-less step still states what to return", () => {
    const steps = [row({ id: "s1", idx: 0, content: "do it", status: "in_progress" })];
    expect(buildStepDelegation(steps, steps[0]!, 1).output_format.length).toBeGreaterThan(0);
  });

  test("an agent type's LOWER cap wins over a generous slice", () => {
    const registry = {
      types: new Map([
        ["reviewer", { name: "reviewer", description: "d", prompt: "", budget_usd: 0.25 }],
        ["deep", { name: "deep", description: "d", prompt: "", budget_usd: 5 }],
      ]),
      warnings: [],
    };
    const cheap = row({ id: "s1", idx: 0, status: "in_progress", agent_type: "reviewer" });
    // A type declaring budget_usd: 0.25 means it — a generous plan total must not widen it.
    expect(buildStepDelegation([cheap], cheap, 2, registry).budget_usd).toBeCloseTo(0.25, 6);

    // The reverse does NOT widen: the slice is the plan's ceiling regardless of the type.
    const rich = row({ id: "s2", idx: 0, status: "in_progress", agent_type: "deep" });
    expect(buildStepDelegation([rich], rich, 2, registry).budget_usd).toBeCloseTo(2, 6);

    // A type with no cap, and an unknown name, both fall through to the slice.
    const plain = row({ id: "s3", idx: 0, status: "in_progress", agent_type: "nope" });
    expect(buildStepDelegation([plain], plain, 2, registry).budget_usd).toBeCloseTo(2, 6);
  });
});
