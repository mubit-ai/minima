import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AfterToolCallContext, BeforeToolCallContext } from "../src/agent/tools.ts";
import type { GateRow } from "../src/db/minima_db.ts";
import { MinimaDb } from "../src/db/minima_db.ts";
import { groundTruthHooks } from "../src/minima/ground_truth.ts";

// Stage 4 — the done-gate (M4.1 block-on-fail, M4.2 red→green, M4.3 durable gate rows).
// The before-hook previews which steps a todowrite would flip to completed, runs each flip's
// `verify`, and refuses the WHOLE call when any check fails or cannot run; the after-hook
// writes one gate row per allowed flip. All checks here use instant commands (true/exit N).

/** A fresh in-memory ledger per test — no shared state, no disk. */
function db(): MinimaDb {
  return new MinimaDb(":memory:");
}

function bctx(todos: unknown[], id = "tc", live?: Set<string>): BeforeToolCallContext {
  const args = { tasks: JSON.stringify(todos) };
  return {
    toolCall: { type: "toolCall", id, name: "todowrite", arguments: args },
    args,
    ...(live ? { context: { pendingToolCalls: live } } : {}),
  } as unknown as BeforeToolCallContext;
}

function actx(todos: unknown[], id = "tc", isError = false): AfterToolCallContext {
  return {
    toolCall: { type: "toolCall", id, name: "todowrite", arguments: { tasks: JSON.stringify(todos) } },
    isError,
  } as unknown as AfterToolCallContext;
}

function gates(d: MinimaDb): GateRow[] {
  return d.db.query("SELECT * FROM gates ORDER BY created_at, rowid").all() as GateRow[];
}

function factorsOf(row: GateRow): Record<string, unknown> {
  return JSON.parse(row.factors_json ?? "{}");
}

// --------------------------------------------------------------------------- completionsForTodos

describe("MinimaDb.completionsForTodos", () => {
  test("no plan: every completed todo is a flip with null stepId/baseline", () => {
    const d = db();
    const flips = d.completionsForTodos("run1", [
      { content: "A", status: "completed", verify: "true" },
      { content: "B", status: "pending" },
      { content: "C", status: "completed" },
    ]);
    expect(flips).toEqual([
      { content: "A", stepId: null, verify: "true", baseline: null },
      { content: "C", stepId: null, verify: null, baseline: null },
    ]);
  });

  test("matches existing steps and COALESCEs the effective verify like the upsert", () => {
    const d = db();
    const first = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "bun test a" },
      { content: "B", status: "pending" },
    ]);
    d.setStepBaseline(first.stepIds[0]!, "red");
    const flips = d.completionsForTodos("run1", [
      { content: "A", status: "completed" },
      { content: "B", status: "completed", verify: "bun test b" },
    ]);
    expect(flips).toEqual([
      { content: "A", stepId: first.stepIds[0]!, verify: "bun test a", baseline: "red" },
      { content: "B", stepId: first.stepIds[1]!, verify: "bun test b", baseline: null },
    ]);
  });

  test("a step already completed that stays completed is not a flip", () => {
    const d = db();
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "completed" }]);
    expect(d.completionsForTodos("run1", [{ content: "A", status: "completed" }])).toEqual([]);
  });

  test("a completed→reopened→completed step is a new flip (new verification cycle)", () => {
    const d = db();
    const { stepIds } = d.upsertPlanFromTodos("run1", [{ content: "A", status: "completed" }]);
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    const flips = d.completionsForTodos("run1", [{ content: "A", status: "completed" }]);
    expect(flips.map((f) => f.stepId)).toEqual([stepIds[0]!]);
  });

  test("is read-only: previewing mutates neither statuses nor verify", () => {
    const d = db();
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    d.completionsForTodos("run1", [{ content: "A", status: "completed", verify: "false" }]);
    const steps = d.getPlanSteps(planId);
    expect(steps[0]!.status).toBe("in_progress");
    expect(steps[0]!.verify).toBe("true");
    expect(gates(d)).toHaveLength(0);
  });

  test("duplicate contents consume matches first-come, exactly like the upsert", () => {
    const d = db();
    const { stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "A", status: "pending", verify: "true" },
    ]);
    const flips = d.completionsForTodos("run1", [
      { content: "A", status: "completed" },
      { content: "A", status: "completed" },
    ]);
    // First todo matches the already-completed row (no flip); second matches the pending one.
    expect(flips).toEqual([{ content: "A", stepId: stepIds[1]!, verify: "true", baseline: null }]);
  });
});

// --------------------------------------------------------------------------- the done-gate (M4.1/M4.2)

describe("done-gate before-hook (M4.1)", () => {
  test("a failing verify blocks: reason names the step + output tail, status unchanged, failed row written", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "Fix the parser", status: "in_progress", verify: "echo boom; exit 3" },
    ]);
    const decision = await before(bctx([{ content: "Fix the parser", status: "completed" }]));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain('Step not verified — "Fix the parser"');
    expect(decision?.reason).toContain("`echo boom; exit 3` failed:");
    expect(decision?.reason).toContain("boom");
    expect(decision?.reason).toContain("statuses were left unchanged");
    expect(d.getPlanSteps(planId)[0]!.status).toBe("in_progress");
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("failed");
    expect(rows[0]!.verified_by).toBe("deterministic");
    expect(rows[0]!.kind).toBe("step_check");
    expect(rows[0]!.step_id).toBe(stepIds[0]!);
    expect(rows[0]!.plan_id).toBe(planId);
    const f = factorsOf(rows[0]!);
    expect(f.pass).toBe(false);
    expect(f.hasCheck).toBe(true);
    expect(f.outputTail).toContain("boom");
    expect(f.exitCode).toBe(3);
  });

  test("a passing verify allows the call and the after-hook writes a verified row", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const plan = d.getActivePlan("run1")!;
    const steps = d.getPlanSteps(plan.id);
    expect(steps[0]!.status).toBe("completed");
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("verified");
    expect(rows[0]!.verified_by).toBe("deterministic");
    expect(rows[0]!.step_id).toBe(steps[0]!.id);
    expect(factorsOf(rows[0]!).redToGreen).toBe(false); // baseline was null
  });

  test("M4.2 red→green: baseline red + passing check sets factors.redToGreen true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-gate-"));
    const flag = join(dir, "flag");
    try {
      const d = db();
      const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
      const verify = `test -f ${flag}`;
      // in_progress with a verify → the sink captures the baseline (flag absent → red).
      await after(actx([{ content: "A", status: "in_progress", verify }], "tc0"));
      const plan = d.getActivePlan("run1")!;
      expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("red");
      writeFileSync(flag, "");
      const todos = [{ content: "A", status: "completed" }]; // verify omitted → COALESCE keeps it
      expect(await before(bctx(todos, "tc1"))).toBeNull();
      await after(actx(todos, "tc1"));
      const rows = gates(d);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("verified");
      expect(factorsOf(rows[0]!).redToGreen).toBe(true);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("green baseline: a passing check is verified but redToGreen stays false", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    await after(actx([{ content: "A", status: "in_progress", verify: "true" }], "tc0"));
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBe("green");
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos, "tc1"))).toBeNull();
    await after(actx(todos, "tc1"));
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(factorsOf(rows[0]!).redToGreen).toBe(false);
  });

  test("unrunnable (timeout under a tiny injected budget) blocks with an unrunnable row", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { gateBudgetMs: 50 });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "sleep 5" }]);
    const decision = await before(bctx([{ content: "A", status: "completed" }]));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("could not run");
    expect(decision?.reason).toContain("timed out");
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("unrunnable");
    expect(rows[0]!.verified_by).toBe("deterministic");
    expect(d.getPlanSteps(d.getActivePlan("run1")!.id)[0]!.status).toBe("in_progress");
  });

  test("unrunnable (budget exhausted before the check could start) blocks", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" }, { gateBudgetMs: 0 });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const decision = await before(bctx([{ content: "A", status: "completed" }]));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("budget was exhausted");
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("unrunnable");
  });

  test("verify-less completion is allowed and records an unchecked row with NULL verified_by (M4.3)", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress" }]);
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("unchecked");
    expect(rows[0]!.verified_by).toBeNull();
    const f = factorsOf(rows[0]!);
    expect(f.hasCheck).toBe(false);
    expect(f.pass).toBe(false);
    expect(f.checkOrigin).toBe("agent_new");
  });

  test("mixed batch: one failure blocks the WHOLE call — no statuses change, no verified/unchecked rows", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "Bad", status: "in_progress", verify: "exit 1" },
      { content: "Good", status: "in_progress", verify: "true" },
      { content: "Plain", status: "in_progress" },
    ]);
    const decision = await before(
      bctx([
        { content: "Bad", status: "completed" },
        { content: "Good", status: "completed" },
        { content: "Plain", status: "completed" },
      ]),
    );
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain('"Bad"');
    expect(d.getPlanSteps(planId).map((s) => s.status)).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
    ]);
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("failed");
  });

  test("multiple failures: the reason names every failing step", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [
      { content: "One", status: "in_progress", verify: "exit 1" },
      { content: "Two", status: "in_progress", verify: "exit 2" },
    ]);
    const decision = await before(
      bctx([
        { content: "One", status: "completed" },
        { content: "Two", status: "completed" },
      ]),
    );
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain('"One"');
    expect(decision?.reason).toContain('"Two"');
    expect(gates(d)).toHaveLength(2);
  });

  test("a brand-new todo inserted directly as completed with a failing verify is blocked (no plan yet)", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    const decision = await before(bctx([{ content: "New", status: "completed", verify: "exit 1" }]));
    expect(decision?.block).toBe(true);
    expect(d.getActivePlan("run1")).toBeNull(); // gate never creates the plan
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("failed");
    expect(rows[0]!.plan_id).toBeNull();
    expect(rows[0]!.step_id).toBeNull();
  });

  test("non-todowrite calls and todowrites with no completion flips pass through untouched", async () => {
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "pending", verify: "exit 1" }]);
    expect(
      await before({
        toolCall: { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
        args: { command: "ls" },
      } as unknown as BeforeToolCallContext),
    ).toBeNull();
    expect(await before(bctx([{ content: "A", status: "in_progress" }]))).toBeNull();
    expect(gates(d)).toHaveLength(0);
  });

  test("fail-open: a db whose preview throws allows the call and never throws", async () => {
    const throwing = {
      completionsForTodos() {
        throw new Error("boom");
      },
    } as unknown as MinimaDb;
    const { before } = groundTruthHooks({ db: throwing, runId: "run1" });
    await expect(before(bctx([{ content: "A", status: "completed", verify: "exit 1" }]))).resolves.toBeNull();
  });

  test("fail-open: missing db or runId allows the call", async () => {
    const { before } = groundTruthHooks({ db: null, runId: "run1" });
    expect(await before(bctx([{ content: "A", status: "completed" }]))).toBeNull();
    const { before: b2 } = groundTruthHooks({ db: db(), runId: null });
    expect(await b2(bctx([{ content: "A", status: "completed" }]))).toBeNull();
  });

  test("a broken insertGate on the block path still blocks (enforcement over bookkeeping)", async () => {
    const real = db();
    real.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "exit 1" }]);
    const faked = {
      completionsForTodos: real.completionsForTodos.bind(real),
      getActivePlan: real.getActivePlan.bind(real),
      insertGate() {
        throw new Error("boom");
      },
    } as unknown as MinimaDb;
    const { before } = groundTruthHooks({ db: faked, runId: "run1" });
    const decision = await before(bctx([{ content: "A", status: "completed" }]));
    expect(decision?.block).toBe(true);
  });

  test("a check that cannot spawn at done-time blocks with an 'unrunnable' attempt row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minima-gate-"));
    const prev = process.cwd();
    const d = db();
    const { before } = groundTruthHooks({ db: d, runId: "run1" });
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    try {
      // Deleting the cwd out from under bash makes Bun.spawn itself throw (ENOENT) — the
      // real spawn-failure path, not a fabricated result.
      process.chdir(dir);
      rmSync(dir, { recursive: true, force: true });
      const decision = await before(bctx([{ content: "A", status: "completed" }]));
      expect(decision?.block).toBe(true);
      expect(decision?.reason).toContain("could not run (spawn error:");
      const rows = gates(d);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("unrunnable");
      expect(rows[0]!.verified_by).toBe("deterministic");
      expect(d.getPlanSteps(planId)[0]!.status).toBe("in_progress");
    } finally {
      process.chdir(prev);
    }
  });
});

// --------------------------------------------------------------------------- same-batch guard (M4.1)

describe("done-gate same-batch guard", () => {
  // loop.ts runs every before-hook in a batch before ANY tool executes, so a second todowrite
  // would preview against pre-batch DB state. The gate refuses it whole: one todowrite per
  // assistant message.

  test("an in_progress+completed pair in one batch cannot sneak a red step past the gate", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    // A was verified earlier but its check has since regressed to red.
    const { planId } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed", verify: "exit 1" },
    ]);
    const live = new Set(["t1", "t2"]);
    const reopen = [{ content: "A", status: "in_progress" }];
    const complete = [{ content: "A", status: "completed" }];
    expect(await before(bctx(reopen, "t1", live))).toBeNull();
    const decision = await before(bctx(complete, "t2", live));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("Only one todowrite per assistant message");
    // Only t1 executes (t2 was refused whole): A is back in_progress with zero gate rows.
    await after(actx(reopen, "t1"));
    live.clear();
    expect(d.getPlanSteps(planId)[0]!.status).toBe("in_progress");
    expect(gates(d)).toHaveLength(0);
    // The NEXT message's completion previews live state and is blocked by the red check.
    const retry = await before(bctx(complete, "t3", new Set(["t3"])));
    expect(retry?.block).toBe(true);
    expect(retry?.reason).toContain("failed");
    expect(d.getPlanSteps(planId)[0]!.status).toBe("in_progress");
    expect(gates(d).map((r) => r.outcome)).toEqual(["failed"]);
  });

  test("two same-batch completions of one step cannot double-write gate rows", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const todos = [{ content: "A", status: "completed" }];
    const live = new Set(["t1", "t2"]);
    expect(await before(bctx(todos, "t1", live))).toBeNull();
    const decision = await before(bctx(todos, "t2", live));
    expect(decision?.block).toBe(true);
    await after(actx(todos, "t1"));
    // Exactly one verified row for the one real flip.
    expect(gates(d).map((r) => r.outcome)).toEqual(["verified"]);
  });

  test("a stale in-flight id from an abandoned batch is pruned via pendingToolCalls", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const todos = [{ content: "A", status: "completed" }];
    // t1 is previewed but its batch dies before execution — its after-hook never fires.
    expect(await before(bctx(todos, "t1", new Set(["t1"])))).toBeNull();
    // A later batch (t1 no longer pending) must not be wedged by the orphan.
    expect(await before(bctx(todos, "t2", new Set(["t2"])))).toBeNull();
    await after(actx(todos, "t2"));
    expect(gates(d).map((r) => r.outcome)).toEqual(["verified"]);
  });

  test("sequential before/after pairs across messages never trip the guard", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
      { content: "B", status: "pending", verify: "true" },
    ]);
    const first = [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
    ];
    expect(await before(bctx(first, "t1"))).toBeNull();
    await after(actx(first, "t1"));
    const second = [
      { content: "A", status: "completed" },
      { content: "B", status: "completed" },
    ];
    expect(await before(bctx(second, "t2"))).toBeNull();
    await after(actx(second, "t2"));
    expect(gates(d).map((r) => r.outcome)).toEqual(["verified", "verified"]);
  });
});

// --------------------------------------------------------------------------- abort wiring

describe("done-gate abort (runSignal)", () => {
  test("an aborted run blocks the completion as 'unrunnable', never a fabricated 'failed'", async () => {
    const d = db();
    const ac = new AbortController();
    ac.abort();
    const { before } = groundTruthHooks({ db: d, runId: "run1", runSignal: ac.signal });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const decision = await before(bctx([{ content: "A", status: "completed" }]));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("aborted");
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("unrunnable");
  });

  test("abort mid-check cancels a slow verify instead of pinning the turn", async () => {
    const d = db();
    const ac = new AbortController();
    const { before } = groundTruthHooks({ db: d, runId: "run1", runSignal: ac.signal });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "sleep 5" }]);
    setTimeout(() => ac.abort(), 50);
    const start = performance.now();
    const decision = await before(bctx([{ content: "A", status: "completed" }]));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(decision?.block).toBe(true);
    expect(gates(d)[0]!.outcome).toBe("unrunnable");
  });

  test("an aborted baseline capture leaves the baseline NULL (signal lost, never fabricated)", async () => {
    const d = db();
    const ac = new AbortController();
    ac.abort();
    const { after } = groundTruthHooks({ db: d, runId: "run1", runSignal: ac.signal });
    await after(actx([{ content: "A", status: "in_progress", verify: "exit 1" }]));
    const plan = d.getActivePlan("run1")!;
    expect(d.getPlanSteps(plan.id)[0]!.baseline).toBeNull();
  });
});

// --------------------------------------------------------------------------- step attribution

describe("done-gate step attribution (duplicate contents)", () => {
  test("two same-content steps flipped in one call each get their own gate row", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [
      { content: "fix flaky test", status: "in_progress", verify: "true" },
      { content: "fix flaky test", status: "in_progress", verify: "true" },
    ]);
    const todos = [
      { content: "fix flaky test", status: "completed" },
      { content: "fix flaky test", status: "completed" },
    ];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const steps = d.getPlanSteps(d.getActivePlan("run1")!.id);
    const rows = gates(d);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.step_id))).toEqual(new Set(steps.map((s) => s.id)));
  });

  test("with an already-completed twin, the row lands on the step that actually flipped", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    const { stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "completed" },
      { content: "A", status: "pending", verify: "true" },
    ]);
    // The preview's consuming matcher flips only the SECOND step; its gate row must not be
    // misattributed to the first (already-completed) twin.
    const todos = [
      { content: "A", status: "completed" },
      { content: "A", status: "completed" },
    ];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("verified");
    expect(rows[0]!.step_id).toBe(stepIds[1]!);
  });
});

// --------------------------------------------------------------------------- gate rows (M4.3)

describe("done-gate after-hook (M4.3)", () => {
  test("exactly one gate row per completion flip; a resend of completed steps adds none", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos, "tc1"))).toBeNull();
    await after(actx(todos, "tc1"));
    expect(gates(d)).toHaveLength(1);
    // Resend the identical list: not a flip → the gate parks nothing and writes nothing.
    expect(await before(bctx(todos, "tc2"))).toBeNull();
    await after(actx(todos, "tc2"));
    expect(gates(d)).toHaveLength(1);
  });

  test("reopen + complete again is a new verification cycle with a second row", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const done = [{ content: "A", status: "completed" }];
    await before(bctx(done, "tc1"));
    await after(actx(done, "tc1"));
    const reopen = [{ content: "A", status: "in_progress" }];
    await before(bctx(reopen, "tc2"));
    await after(actx(reopen, "tc2"));
    await before(bctx(done, "tc3"));
    await after(actx(done, "tc3"));
    const rows = gates(d);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(["verified", "verified"]);
  });

  test("an errored todowrite consumes its parked verdicts without writing rows (pending cleanup)", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [{ content: "A", status: "in_progress", verify: "true" }]);
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos, "tc1"))).toBeNull();
    await after(actx(todos, "tc1", true)); // tool errored — nothing durable happened
    expect(gates(d)).toHaveLength(0);
    // The pending entry is gone: replaying the SAME id without a fresh before writes nothing.
    await after(actx(todos, "tc1"));
    expect(gates(d)).toHaveLength(0);
  });

  test("mixed verified + unchecked verdicts each get their own row with the right stepId", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    d.upsertPlanFromTodos("run1", [
      { content: "Checked", status: "in_progress", verify: "true" },
      { content: "Plain", status: "in_progress" },
    ]);
    const todos = [
      { content: "Checked", status: "completed" },
      { content: "Plain", status: "completed" },
    ];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const plan = d.getActivePlan("run1")!;
    const steps = d.getPlanSteps(plan.id);
    const rows = gates(d);
    expect(rows).toHaveLength(2);
    const byOutcome = new Map(rows.map((r) => [r.outcome, r]));
    expect(byOutcome.get("verified")!.step_id).toBe(steps[0]!.id);
    expect(byOutcome.get("verified")!.verified_by).toBe("deterministic");
    expect(byOutcome.get("unchecked")!.step_id).toBe(steps[1]!.id);
    expect(byOutcome.get("unchecked")!.verified_by).toBeNull();
  });

  test("a brand-new step completed in one shot resolves its stepId from the fresh upsert", async () => {
    const d = db();
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" });
    const todos = [{ content: "New", status: "completed", verify: "true" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const plan = d.getActivePlan("run1")!;
    const steps = d.getPlanSteps(plan.id);
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("verified");
    expect(rows[0]!.step_id).toBe(steps[0]!.id);
    expect(rows[0]!.plan_id).toBe(plan.id);
  });

  test("fail-open: a throwing insertGate breaks neither the turn nor sibling verdict rows", async () => {
    const real = db();
    real.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
      { content: "B", status: "in_progress" },
    ]);
    let calls = 0;
    const faked = {
      completionsForTodos: real.completionsForTodos.bind(real),
      upsertPlanFromTodos: real.upsertPlanFromTodos.bind(real),
      setStepBaseline: real.setStepBaseline.bind(real),
      getActivePlan: real.getActivePlan.bind(real),
      getPlanSteps: real.getPlanSteps.bind(real),
      insertGate(...args: Parameters<MinimaDb["insertGate"]>) {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return real.insertGate(...args);
      },
    } as unknown as MinimaDb;
    const { before, after } = groundTruthHooks({ db: faked, runId: "run1" });
    const todos = [
      { content: "A", status: "completed" },
      { content: "B", status: "completed" },
    ];
    expect(await before(bctx(todos))).toBeNull();
    await expect(after(actx(todos))).resolves.toBeNull();
    expect(gates(real)).toHaveLength(1); // the second verdict still landed
  });
});

// --------------------------------------------------------------------------- Stage 5 factors

// End-to-end wiring of M5.1 provenance / M5.2 coverage / M5.3 tamper through the real
// before/after hooks: real file_changes rows in the ledger + an injected FactorFs for the
// on-disk test contents. `true <path>` is a passing check (true ignores its args) whose verify
// string still names a test file, so provenance can parse it without the check failing.
describe("done-gate Stage 5 factors (M5.1/M5.2/M5.3)", () => {
  function fsFrom(contents: Record<string, string>) {
    return {
      read: (p: string) => contents[p] ?? null,
      exists: (p: string) => p in contents,
    };
  }

  test("agent_new + coverageHit + no tamper: agent wrote the test, and it references the change", async () => {
    const d = db();
    const fs = fsFrom({ "src/foo.test.ts": 'import { foo } from "./foo";' });
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" }, { fs });
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true src/foo.test.ts" },
    ]);
    d.insertFileChange({ planId, stepId: stepIds[0]!, path: "src/foo.ts", kind: "modified" });
    d.insertFileChange({ planId, stepId: stepIds[0]!, path: "src/foo.test.ts", kind: "created" });
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const rows = gates(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("verified");
    const f = factorsOf(rows[0]!);
    expect(f.checkOrigin).toBe("agent_new");
    expect(f.coverageHit).toBe(true);
    expect(f.tamper).toBe(false);
  });

  test("pre_existing + coverage false: an untouched test that doesn't reference the change", async () => {
    const d = db();
    const fs = fsFrom({ "src/foo.test.ts": 'import { other } from "./other";' });
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" }, { fs });
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true src/foo.test.ts" },
    ]);
    d.insertFileChange({ planId, stepId: stepIds[0]!, path: "src/foo.ts", kind: "modified" });
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    const f = factorsOf(gates(d)[0]!);
    expect(f.checkOrigin).toBe("pre_existing");
    expect(f.coverageHit).toBe(false);
    expect(f.tamper).toBe(false);
  });

  test("tamper true: a test file the agent touched now carries a skip marker", async () => {
    const d = db();
    const fs = fsFrom({ "src/foo.test.ts": "it.skip('x', () => {})" });
    const { before, after } = groundTruthHooks({ db: d, runId: "run1" }, { fs });
    const { planId, stepIds } = d.upsertPlanFromTodos("run1", [
      { content: "A", status: "in_progress", verify: "true" },
    ]);
    d.insertFileChange({ planId, stepId: stepIds[0]!, path: "src/foo.test.ts", kind: "modified" });
    const todos = [{ content: "A", status: "completed" }];
    expect(await before(bctx(todos))).toBeNull();
    await after(actx(todos));
    expect(factorsOf(gates(d)[0]!).tamper).toBe(true);
  });
});
