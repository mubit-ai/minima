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
  makePlanDelegate,
  priorResultsFor,
  synthesizeBoundaries,
  MIN_VIABLE_SLICE_USD,
  shouldDelegate,
  sliceForStep,
} from "../src/minima/plan_delegate.ts";
import type { ChildResult, Delegation, SpawnContext } from "../src/tools/task.ts";

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
    expect(d.isolation).toBe("inherit");
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

  test("an agent type's isolation can never force a worktree child", () => {
    const registry = {
      types: new Map([
        [
          "worktree-fan",
          { name: "worktree-fan", description: "d", prompt: "", isolation: "workdir" as const },
        ],
      ]),
      warnings: [],
    };
    const s = row({ id: "s1", idx: 0, status: "in_progress", agent_type: "worktree-fan" });
    // buildStepDelegation always sets isolation itself, so applyAgentType's "fill only what's
    // unset" rule has nothing to fill — a type's isolation can never reach a plan step.
    expect(buildStepDelegation([s], s, 1, registry).isolation).toBe("inherit");
  });
});

describe("budget", () => {
  test("the slice divides what is LEFT among the steps that remain", () => {
    expect(sliceForStep(2, 0, 4)).toBeCloseTo(0.5, 6);
    expect(sliceForStep(2, 1, 2)).toBeCloseTo(0.5, 6);
    // A cheap early step leaves more for the rest — a static split cannot do this.
    expect(sliceForStep(2, 0.1, 3)).toBeCloseTo(0.6333, 3);
  });

  test("the last step gets everything left, and an overspent plan gets zero", () => {
    expect(sliceForStep(2, 1.5, 1)).toBeCloseTo(0.5, 6);
    expect(sliceForStep(2, 2.5, 1)).toBe(0);
    expect(sliceForStep(2, 0, 0)).toBe(0);
  });

  test("a step already delegated never spawns again — the one-attempt guard", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress", delegated_cost_usd: 0 });
    expect(shouldDelegate(s, 2, 0, 1)).toEqual({ ok: false, reason: "already_delegated" });
  });

  test("no approved plan budget means no delegation at all — never a half-state", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress" });
    expect(shouldDelegate(s, null, 0, 1)).toEqual({ ok: false, reason: "no_budget" });
  });

  test("an exhausted plan total stops the next step rather than shrinking it to nothing", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress" });
    expect(shouldDelegate(s, 2, 1.995, 1)).toEqual({ ok: false, reason: "plan_exhausted" });
  });

  test("a thin slice over many steps is NOT the same as an exhausted plan — the money is still there", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress" });
    // $0.10 unspent, but 6 steps left: $0.0167/step is unusable, yet nothing has been spent.
    expect(shouldDelegate(s, 0.1, 0, 6)).toEqual({ ok: false, reason: "slice_too_thin" });
  });

  test("an empty step is not delegated", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress", content: "  " });
    expect(shouldDelegate(s, 2, 0, 1)).toEqual({ ok: false, reason: "no_content" });
  });

  test("a healthy step delegates with its slice", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress" });
    expect(shouldDelegate(s, 2, 0, 4)).toEqual({ ok: true, sliceUsd: 0.5 });
  });
});

function fakeSpawn(res: Partial<ChildResult>) {
  const seen: { d: Delegation; ctx: SpawnContext }[] = [];
  const spawn = async (d: Delegation, ctx: SpawnContext): Promise<ChildResult> => {
    seen.push({ d, ctx });
    return {
      step_id: d.step_id,
      childId: "c1",
      text: "done",
      costUsd: 0.05,
      quality: null,
      outcome: "success",
      workdir: null,
      ...res,
    };
  };
  return { spawn, seen };
}

describe("the delegate seam", () => {
  test("a delegated step spawns once, stores its result, and books its spend", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [
      { content: "one" },
      { content: "two" },
    ]);
    db.setPlanBudget(planId, 2);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const booked: number[] = [];
    const { spawn, seen } = fakeSpawn({ text: "wired it up", costUsd: 0.07 });
    const delegate = makePlanDelegate({ db, spawn, onSpend: (u) => booked.push(u) });

    const report = await delegate(planId, stepIds[0]!);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.d.objective).toBe("one");
    expect(seen[0]!.d.budget_usd).toBeCloseTo(1, 6);
    expect(report).toContain("wired it up");
    expect(db.getPlanSteps(planId)[0]!.result).toBe("wired it up");
    expect(db.planDelegatedSpend(planId)).toBeCloseTo(0.07, 6);
    expect(booked).toEqual([0.07]);
  });

  test("the child runs in the parent workdir — isolation would cap the plan at yellow", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [{ content: "one" }]);
    db.setPlanBudget(planId, 2);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const { spawn, seen } = fakeSpawn({});
    await makePlanDelegate({ db, spawn })(planId, stepIds[0]!);
    expect(seen[0]!.d.isolation).toBe("inherit");
  });

  test("a failed child stamps cost anyway and cannot be re-delegated", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [{ content: "one" }]);
    db.setPlanBudget(planId, 2);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const { spawn, seen } = fakeSpawn({ outcome: "failure", text: "boom", costUsd: 0.03 });
    const delegate = makePlanDelegate({ db, spawn });

    const first = await delegate(planId, stepIds[0]!);
    expect(first).toContain("boom");
    expect(first!.toLowerCase()).toContain("finish this step yourself");
    expect(db.getPlanSteps(planId)[0]!.delegated_cost_usd).toBeCloseTo(0.03, 6);

    const second = await delegate(planId, stepIds[0]!);
    expect(second).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("without an approved budget nothing spawns", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [{ content: "one" }]);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const { spawn, seen } = fakeSpawn({});
    expect(await makePlanDelegate({ db, spawn })(planId, stepIds[0]!)).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test("an exhausted plan total stops the plan and says so", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [
      { content: "one" },
      { content: "two" },
    ]);
    db.setPlanBudget(planId, 0.5);
    db.recordStepDelegation(stepIds[0]!, "spent it", 0.5);
    db.setStepStatus(stepIds[1]!, "in_progress");
    const { spawn, seen } = fakeSpawn({});
    const report = await makePlanDelegate({ db, spawn })(planId, stepIds[1]!);
    expect(seen).toHaveLength(0);
    expect(report).toContain("$0.50");
    expect(report!.toLowerCase()).toContain("budget");
  });

  test("a thin slice reports honestly — the budget is not spent, just spread too thin", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps(
      "s",
      "T",
      Array.from({ length: 6 }, (_, i) => ({ content: `step ${i}` })),
    );
    db.setPlanBudget(planId, 0.1);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const { spawn, seen } = fakeSpawn({});
    const report = await makePlanDelegate({ db, spawn })(planId, stepIds[0]!);
    expect(seen).toHaveLength(0);
    expect(report).toContain("$0.10");
    expect(report!.toLowerCase()).toContain("budget");
    expect(report!.toLowerCase()).not.toContain("exhausted");
    expect(report!.toLowerCase()).not.toContain("is spent");
  });

  test("a spawn that throws is reported, not propagated — bookkeeping never breaks a turn", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [{ content: "one" }]);
    db.setPlanBudget(planId, 2);
    db.setStepStatus(stepIds[0]!, "in_progress");
    const spawn = async (): Promise<ChildResult> => {
      throw new Error("provider exploded");
    };
    const report = await makePlanDelegate({ db, spawn })(planId, stepIds[0]!);
    expect(report).toContain("provider exploded");
    expect(db.getPlanSteps(planId)[0]!.delegated_cost_usd).toBe(0);
  });

  test("prior completed results reach the child through depends_on", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [
      { content: "one" },
      { content: "two" },
    ]);
    db.setPlanBudget(planId, 2);
    db.recordStepDelegation(stepIds[0]!, "found the seam", 0.01);
    db.setStepStatus(stepIds[0]!, "completed");
    db.setStepStatus(stepIds[1]!, "in_progress");
    const { spawn, seen } = fakeSpawn({});
    await makePlanDelegate({ db, spawn })(planId, stepIds[1]!);
    expect(seen[0]!.d.depends_on).toEqual([stepIds[0]!]);
    expect(seen[0]!.ctx.priorResults[0]!.text).toBe("found the seam");
  });
});
