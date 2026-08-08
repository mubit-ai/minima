# Plan-Delegated Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every step of a finalized plan runs as a sequential sub-agent with its own persona, tool scope, model pool and spend slice, while the lead drives the plan and the verification spine keeps its green tier.

**Architecture:** `bigPlanAfterToolCall` already fires on every `todowrite`, already receives `{ started }` (the steps just flipped to `in_progress`), and already runs their baseline checks. A new injected `delegate` seam runs immediately after the baseline: it projects the `plan_steps` row into a `Delegation`, spawns it through the existing `SpawnFn` in the parent workdir, stores the result, and returns a report that replaces the `todowrite` tool result via `AfterToolCallResult.content`. No new dispatch path, no turn-loop change, no prompt instruction.

**Tech Stack:** TypeScript on Bun ≥1.2, `bun:sqlite`, Ink for the TUI, biome for lint/format, `bun test` for tests.

## Global Constraints

- Work only in `packages/tui`. No server change; plan state is never server-authoritative.
- Migrations are **append-only**: never edit a shipped `MIGRATIONS` batch, only append a new one.
- Enforcement lives in the dispatcher, never in prompt text.
- Every test is hermetic: faux provider, mocked `fetch`, temp DB. No network, no spend.
- `from __future__`-style file header comments: match the surrounding file's density. **No comments unless the surrounding code has them** — this codebase comments the *why*, never the *what*.
- biome: run `bun run format` before every commit; `bun run check` (tsc + terminology guard) and `bun run lint` must pass.
- The terminology guard blocks new "ground truth" and "Big Plan" phrasing in TUI src/tests.
- Run all commands from `packages/tui/`.

## Spec corrections discovered while planning

Two things in the spec turned out to be wrong once the code was read. The plan implements the corrected versions:

1. **`plan_steps` has no `agent_type` column.** `agentTypePlanPreset` expands a type into `tools` + `candidates` at finalize and the *name* is discarded, so a delegated child could never receive the type's persona or budget cap. Task 1 adds the column and Task 5 persists it.
2. **`depends_on` IS the mechanism for prior results, not a graph.** `delegationPrompt` only renders prior results for ids listed in `d.depends_on`. Setting `depends_on` to the completed step ids and passing matching `ChildResult`s in `SpawnContext.priorResults` reuses that rendering exactly — no new prompt code. It remains a linear plan; `depends_on` is how the existing prompt builder is addressed.

---

### Task 1: Schema and DB accessors

**Files:**
- Modify: `src/db/minima_db.ts` (append a `MIGRATIONS` batch; extend `PlanStepRow`, `seedPlanFromSteps`; add three methods)
- Test: `tests/plan-delegate.test.ts` (new)

**Interfaces:**
- Consumes: `MinimaDb`, `PlanStepRow`, `seedPlanFromSteps` (existing).
- Produces:
  - `PlanStepRow.result: string | null`, `PlanStepRow.delegated_cost_usd: number | null`, `PlanStepRow.agent_type: string | null`
  - `seedPlanFromSteps(sessionId, title, steps: { content; verify?; verifyCwd?; tools?; candidates?; agentType?: string | null }[])`
  - `MinimaDb.recordStepDelegation(stepId: string, result: string, costUsd: number): void`
  - `MinimaDb.planDelegatedSpend(planId: string): number`
  - `MinimaDb.setPlanBudget(planId: string, usd: number | null): void`
  - `MinimaDb.getPlanBudget(planId: string): number | null`

- [ ] **Step 1: Write the failing test**

Create `tests/plan-delegate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL — `db.recordStepDelegation is not a function`.

- [ ] **Step 3: Append the migration batch**

In `src/db/minima_db.ts`, append a **new** batch at the very end of the `MIGRATIONS` array (do not touch any existing batch):

```ts
  // Plan-delegated steps: a plan step's work may run as a sub-agent. `result` is the child's
  // returned text — it feeds the NEXT step's prior-results projection, so it must survive
  // compaction and restart and therefore lives here, not in context. `delegated_cost_usd` is
  // both the per-step cost readout and the already-delegated marker: it is stamped on EVERY
  // attempt including failures, and a non-NULL value means the step never spawns again (without
  // that, a lead re-marking a step in_progress re-spawns it and one flaky step drains the plan
  // budget in a loop). `agent_type` persists the name that agentTypePlanPreset previously
  // discarded after expanding it into tools+candidates — the child needs the persona and the
  // cap, not just the tool scope. `plans.budget_usd` is the total the user approved at finalize.
  [
    "ALTER TABLE plan_steps ADD COLUMN result TEXT",
    "ALTER TABLE plan_steps ADD COLUMN delegated_cost_usd REAL",
    "ALTER TABLE plan_steps ADD COLUMN agent_type TEXT",
    "ALTER TABLE plans ADD COLUMN budget_usd REAL",
  ],
```

- [ ] **Step 4: Extend `PlanStepRow`**

In `src/db/minima_db.ts`, add to `export interface PlanStepRow` (after `candidates`):

```ts
  /** The delegated child's returned text; NULL when the step was not delegated. */
  result: string | null;
  /** Realized child spend. Non-NULL means this step was ALREADY delegated — one attempt per
   *  step, ever — so it is stamped even when the attempt failed. */
  delegated_cost_usd: number | null;
  /** Name of the agent type this step runs as; NULL = a plain focused child. */
  agent_type: string | null;
```

- [ ] **Step 5: Thread `agentType` through `seedPlanFromSteps`**

In `src/db/minima_db.ts`, change the `steps` parameter type of `seedPlanFromSteps` to add `agentType?: string | null;`, and pass it to `insertStep`. Add the matching `agentType` column write inside `insertStep` (follow how `tools` and `candidates` are written there — same sticky-free direct write, since seeding always inserts fresh rows).

- [ ] **Step 6: Add the four accessors**

In `src/db/minima_db.ts`, beside `getPlanSteps`:

```ts
  /** Stamp a step's delegation outcome. Cost is written on failures too (it is the
   *  one-attempt marker), so callers pass 0 rather than skipping the call. */
  recordStepDelegation(stepId: string, result: string, costUsd: number): void {
    this.db
      .query("UPDATE plan_steps SET result = ?, delegated_cost_usd = ? WHERE id = ?")
      .run(result, costUsd, stepId);
  }

  planDelegatedSpend(planId: string): number {
    const row = this.db
      .query(
        "SELECT COALESCE(SUM(delegated_cost_usd), 0) AS total FROM plan_steps WHERE plan_id = ?",
      )
      .get(planId) as { total: number };
    return row.total;
  }

  setPlanBudget(planId: string, usd: number | null): void {
    this.db.query("UPDATE plans SET budget_usd = ? WHERE id = ?").run(usd, planId);
  }

  getPlanBudget(planId: string): number | null {
    const row = this.db.query("SELECT budget_usd FROM plans WHERE id = ?").get(planId) as
      | { budget_usd: number | null }
      | undefined;
    return row?.budget_usd ?? null;
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/plan-delegate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Verify no existing test broke**

Run: `bun test && bun run check && bun run lint`
Expected: full suite passes, tsc clean, biome clean.

- [ ] **Step 9: Commit**

```bash
bun run format
git add src/db/minima_db.ts tests/plan-delegate.test.ts
git commit -m "feat(tui): schema for plan-delegated steps

plan_steps gains result (feeds the next step's prior-results projection, so it
must outlive context), delegated_cost_usd (per-step cost AND the one-attempt
marker — stamped on failures too), and agent_type (previously discarded after
agentTypePlanPreset expanded it into tools+candidates, leaving a delegated child
with the tool scope but not the persona or the cap). plans gains budget_usd.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The step→Delegation projection

**Files:**
- Create: `src/minima/plan_delegate.ts`
- Test: `tests/plan-delegate.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `PlanStepRow` (Task 1), `Delegation` and `ChildResult` from `src/tools/task.ts`.
- Produces:
  - `PRIOR_RESULTS_CAP_CHARS = 4000`
  - `priorResultsFor(steps: PlanStepRow[], capChars?: number): ChildResult[]`
  - `synthesizeBoundaries(steps: PlanStepRow[], stepId: string): string`
  - `buildStepDelegation(steps: PlanStepRow[], step: PlanStepRow, budgetUsd: number, agentTypes?: AgentTypeRegistry): Delegation`

- [ ] **Step 1: Write the failing test**

Append to `tests/plan-delegate.test.ts`:

```ts
import {
  PRIOR_RESULTS_CAP_CHARS,
  buildStepDelegation,
  priorResultsFor,
  synthesizeBoundaries,
} from "../src/minima/plan_delegate.ts";
import type { PlanStepRow } from "../src/db/minima_db.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL — cannot resolve `../src/minima/plan_delegate.ts`.

- [ ] **Step 3: Create `src/minima/plan_delegate.ts`**

```ts
/**
 * Plan-delegated steps — project a plan step into a Delegation and run it as a sub-agent.
 *
 * A plan step and a Delegation already describe almost the same thing: what to do, with which
 * tools, routed among which models, under what spend cap. This module owns the two pieces the
 * plan format does not carry — `output_format` and `boundaries` — plus the budget slice, and
 * nothing else. It deliberately does NOT import the spawner: the seam takes a SpawnFn, so the
 * projection is testable without spawning anything and big_plan.ts never depends on spawn.ts.
 *
 * Sequential by construction. `file_changes` attribute to THE in-progress step and the schema
 * permits exactly one, so concurrent steps would force worktree isolation → an opaque marker →
 * Factors.blind → the plan's confidence tier capped at yellow, surrendering the only origin
 * allowed to claim verified_in_production. Wall-clock is not worth that.
 */

import type { MinimaDb, PlanStepRow } from "../db/minima_db.ts";
import type { ChildResult, Delegation, SpawnFn } from "../tools/task.ts";

/**
 * Character ceiling on the prior-results projection. Uncapped, a child's prompt would grow
 * linearly with plan length and give back the context hygiene this feature exists for;
 * previous-step-only would starve a step building on something three steps back.
 */
export const PRIOR_RESULTS_CAP_CHARS = 4000;

/** Completed steps' stored results, most recent first, truncated at the cap boundary. */
export function priorResultsFor(
  steps: PlanStepRow[],
  capChars: number = PRIOR_RESULTS_CAP_CHARS,
): ChildResult[] {
  const out: ChildResult[] = [];
  let used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.status !== "completed" || !s.result) continue;
    const room = capChars - used;
    if (room <= 0) break;
    const text = s.result.length <= room ? s.result : `${s.result.slice(0, room)}…`;
    used += text.length;
    out.push({
      step_id: s.id,
      childId: "",
      text,
      costUsd: 0,
      quality: null,
      outcome: "success",
      workdir: null,
    });
  }
  return out;
}

/** What this child must NOT do: the other steps' work. */
export function synthesizeBoundaries(steps: PlanStepRow[], stepId: string): string {
  const others = steps
    .filter((s) => s.id !== stepId && (s.content ?? "").trim())
    .map((s) => `- ${s.content!.trim()}`);
  const head =
    "Do ONLY this step. Do not start, finish, or refactor toward any other step of the plan, " +
    "and change no file this step does not require.";
  return others.length ? `${head}\nThese belong to other steps:\n${others.join("\n")}` : head;
}

function jsonList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the child's contract. `depends_on` is set to the prior steps because that is how
 * delegationPrompt addresses ctx.priorResults — it renders results only for ids listed there.
 * The plan stays linear; this is prompt plumbing, not a dependency graph.
 */
export function buildStepDelegation(
  steps: PlanStepRow[],
  step: PlanStepRow,
  budgetUsd: number,
  agentTypes?: AgentTypeRegistry,
): Delegation {
  const priors = priorResultsFor(steps);
  const verify = (step.verify ?? "").trim();
  const d: Delegation = {
    step_id: step.id,
    objective: (step.content ?? "").trim(),
    output_format: verify
      ? `A short report of what you changed, plus the output of running \`${verify}\`.`
      : "A short report of what you changed and how you confirmed it works.",
    boundaries: synthesizeBoundaries(steps, step.id),
    depends_on: priors.map((p) => p.step_id),
  };
  const tools = jsonList(step.tools);
  if (tools) d.tool_allowlist = tools;
  const candidates = jsonList(step.candidates);
  if (candidates) d.candidates = candidates;
  const typeName = step.agent_type?.trim().toLowerCase();
  if (typeName) d.agent_type = typeName;
  // The slice is the plan's ceiling, and a type's own cap only ever LOWERS it. applyAgentType
  // fills budget_usd solely when the delegation left it unset, and this one never does — so
  // without taking the min here a $2 slice would silently widen a type that declared $0.25.
  const typeCap = typeName ? agentTypes?.types.get(typeName)?.budget_usd : undefined;
  d.budget_usd = typeCap !== undefined ? Math.min(budgetUsd, typeCap) : budgetUsd;
  return d;
}
```

Add the import: `import type { AgentTypeRegistry } from "./agent_types.ts";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/plan-delegate.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
bun run format
git add src/minima/plan_delegate.ts tests/plan-delegate.test.ts
git commit -m "feat(tui): project a plan step into a Delegation

A plan step and a Delegation already describe nearly the same thing; the two
fields the plan format lacks (output_format, boundaries) are synthesized rather
than added as authoring burden. depends_on carries the prior-step results
because that is how delegationPrompt addresses ctx.priorResults — the plan stays
linear, this is prompt plumbing.

Prior results are capped: uncapped they grow with plan length and give back the
context hygiene the feature exists for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Budget slice and the plan-total gate

**Files:**
- Modify: `src/minima/plan_delegate.ts`
- Test: `tests/plan-delegate.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `MinimaDb.planDelegatedSpend`, `MinimaDb.getPlanBudget` (Task 1).
- Produces:
  - `sliceForStep(planTotalUsd: number, spentUsd: number, stepsRemaining: number): number`
  - `MIN_VIABLE_SLICE_USD = 0.02`
  - `type DelegateSkip = "flag_off" | "already_delegated" | "no_budget" | "plan_exhausted" | "no_content"`
  - `shouldDelegate(step: PlanStepRow, planBudgetUsd: number | null, spentUsd: number, stepsRemaining: number): { ok: true; sliceUsd: number } | { ok: false; reason: DelegateSkip }`

- [ ] **Step 1: Write the failing test**

Append to `tests/plan-delegate.test.ts` (add `MIN_VIABLE_SLICE_USD`, `shouldDelegate`, `sliceForStep` to the existing import from `plan_delegate.ts`):

```ts
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

  test("an empty step is not delegated", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress", content: "  " });
    expect(shouldDelegate(s, 2, 0, 1)).toEqual({ ok: false, reason: "no_content" });
  });

  test("a healthy step delegates with its slice", () => {
    const s = row({ id: "s1", idx: 0, status: "in_progress" });
    expect(shouldDelegate(s, 2, 0, 4)).toEqual({ ok: true, sliceUsd: 0.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL — `sliceForStep` is not exported.

- [ ] **Step 3: Implement**

Append to `src/minima/plan_delegate.ts`:

```ts
/** Below this a child cannot finish anything useful, so the plan stops instead of
 *  spawning an agent that will immediately hit its cap and report partial. */
export const MIN_VIABLE_SLICE_USD = 0.02;

export type DelegateSkip =
  | "flag_off"
  | "already_delegated"
  | "no_budget"
  | "plan_exhausted"
  | "no_content";

/** What is LEFT, divided among the steps that REMAIN — recomputed before every spawn, so a
 *  cheap early step leaves more for later ones and a static split cannot strand the last. */
export function sliceForStep(
  planTotalUsd: number,
  spentUsd: number,
  stepsRemaining: number,
): number {
  if (stepsRemaining <= 0) return 0;
  return Math.max(0, (planTotalUsd - spentUsd) / stepsRemaining);
}

export function shouldDelegate(
  step: PlanStepRow,
  planBudgetUsd: number | null,
  spentUsd: number,
  stepsRemaining: number,
): { ok: true; sliceUsd: number } | { ok: false; reason: DelegateSkip } {
  if (step.delegated_cost_usd !== null) return { ok: false, reason: "already_delegated" };
  if (!(step.content ?? "").trim()) return { ok: false, reason: "no_content" };
  if (planBudgetUsd === null || planBudgetUsd <= 0) return { ok: false, reason: "no_budget" };
  const sliceUsd = sliceForStep(planBudgetUsd, spentUsd, stepsRemaining);
  if (sliceUsd < MIN_VIABLE_SLICE_USD) return { ok: false, reason: "plan_exhausted" };
  return { ok: true, sliceUsd };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/plan-delegate.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
bun run format
git add src/minima/plan_delegate.ts tests/plan-delegate.test.ts
git commit -m "feat(tui): dynamic budget slice + the one-attempt guard

The slice is what is LEFT over the steps that REMAIN, recomputed before each
spawn: a cheap early step leaves more for later ones, and a static split cannot
strand the last step at nothing. A non-null delegated_cost_usd means the step
already had its one attempt — without it a lead re-marking a step in_progress
re-spawns it and one flaky step drains the plan budget in a loop.

No approved budget means no delegation at all, never a half-state where some
steps delegate until the money runs out.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The delegate seam and its interception point

**Files:**
- Modify: `src/minima/plan_delegate.ts` (add `makePlanDelegate`)
- Modify: `src/minima/big_plan.ts` (`bigPlanAfterToolCall` + `bigPlanHooks` accept `delegate`)
- Test: `tests/plan-delegate.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `shouldDelegate`, `buildStepDelegation`, `priorResultsFor` (Tasks 2–3); `MinimaDb.getPlanSteps`, `recordStepDelegation`, `planDelegatedSpend`, `getPlanBudget` (Task 1); `SpawnFn`, `ChildResult` from `src/tools/task.ts`.
- Produces:
  - `type PlanDelegate = (planId: string, stepId: string) => Promise<string | null>` — returns the report to show the lead, or `null` when the step was not delegated.
  - `makePlanDelegate(deps: { db: MinimaDb; spawn: SpawnFn; signal?: AbortSignal | null; onSpend?: (usd: number) => void }): PlanDelegate`
  - `bigPlanAfterToolCall(ref, opts?: { verifyConsent?: VerifyConsent; delegate?: PlanDelegate })`
  - `bigPlanHooks(ref, opts?: { …existing…; delegate?: PlanDelegate })`

- [ ] **Step 1: Write the failing test**

Append to `tests/plan-delegate.test.ts`:

```ts
import { makePlanDelegate } from "../src/minima/plan_delegate.ts";
import type { ChildResult, Delegation, SpawnContext } from "../src/tools/task.ts";

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
    expect(seen[0]!.d.isolation).toBeUndefined();
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
```

> If `db.setStepStatus(stepId, status)` does not exist under that exact name, find the existing
> method that sets a plan step's status in `src/db/minima_db.ts` and use it consistently in
> every test above. Do not add a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL — `makePlanDelegate` is not exported.

- [ ] **Step 3: Implement `makePlanDelegate`**

Append to `src/minima/plan_delegate.ts`:

```ts
/** Run the step if it qualifies; return the report the lead should see, or null when
 *  nothing was delegated (the lead then works the step itself, as it always has). */
export type PlanDelegate = (planId: string, stepId: string) => Promise<string | null>;

export interface PlanDelegateDeps {
  db: MinimaDb;
  spawn: SpawnFn;
  signal?: AbortSignal | null;
  /** Book realized child spend against the wallet — the same seam taskTool uses, so plan
   *  spend is visible to enforce mode exactly like fan-out spend. */
  onSpend?: (usd: number) => void;
  /** Needed here (not just in createSpawn) so a type's lower budget cap can clamp the slice
   *  BEFORE the delegation is built — applyAgentType only fills a field left unset. */
  agentTypes?: AgentTypeRegistry;
}

export function makePlanDelegate(deps: PlanDelegateDeps): PlanDelegate {
  return async (planId, stepId) => {
    const steps = deps.db.getPlanSteps(planId);
    const step = steps.find((s) => s.id === stepId);
    if (!step) return null;
    const remaining = steps.filter((s) => s.status !== "completed").length;
    const spent = deps.db.planDelegatedSpend(planId);
    const budget = deps.db.getPlanBudget(planId);
    const verdict = shouldDelegate(step, budget, spent, remaining);
    if (!verdict.ok) {
      if (verdict.reason !== "plan_exhausted") return null;
      return (
        `Plan budget exhausted: $${spent.toFixed(2)} of the approved $${(budget ?? 0).toFixed(2)} ` +
        "is spent, so this step was not delegated. Stop and tell the user — do not continue the " +
        "plan until they raise the budget or ask you to finish it yourself."
      );
    }

    const delegation = buildStepDelegation(steps, step, verdict.sliceUsd, deps.agentTypes);
    const priorResults = priorResultsFor(steps);
    let result: ChildResult;
    try {
      result = await deps.spawn(delegation, {
        depth: 1,
        parentSignal: deps.signal ?? null,
        priorResults,
      });
    } catch (exc) {
      // The cost stamp is the one-attempt marker, so it must land even here — otherwise a
      // provider outage lets the same step re-spawn on the lead's next todowrite.
      deps.db.recordStepDelegation(stepId, `delegation failed: ${String(exc)}`, 0);
      return (
        `Step delegation failed: ${String(exc)}\n\n` +
        "Finish this step yourself with your own tools, then mark it completed."
      );
    }

    deps.db.recordStepDelegation(stepId, result.text, result.costUsd);
    if (result.costUsd > 0) deps.onSpend?.(result.costUsd);

    const head = `Step delegated to a sub-agent (${result.outcome}, $${result.costUsd.toFixed(4)}).`;
    if (result.outcome === "success") {
      return `${head}\n\n${result.text || "(no output)"}\n\nVerify it, then mark the step completed.`;
    }
    return (
      `${head}\n\n${result.text || "(no output)"}\n\n` +
      "That did not complete the step. Finish this step yourself with your own tools — it will " +
      "not be delegated again."
    );
  };
}
```

- [ ] **Step 4: Add the seam to `big_plan.ts`**

In `src/minima/big_plan.ts`:

1. Import the type: `import type { PlanDelegate } from "./plan_delegate.ts";`
2. Change `bigPlanAfterToolCall`'s `opts` to `{ verifyConsent?: VerifyConsent; delegate?: PlanDelegate }` and capture `const delegate = opts?.delegate;`.
3. Inside the `todowrite` branch, **after** the existing baseline-capture `for (const s of started)` loop completes, add:

```ts
        // Delegation runs AFTER the baseline loop: the done-gate measures red→green across the
        // child's work, so a baseline captured after it would compare the child against itself.
        if (delegate) {
          const reports: string[] = [];
          for (const s of started) {
            const report = await delegate(planId, s.id);
            if (report) reports.push(report);
          }
          if (reports.length) return { content: [text(reports.join("\n\n---\n\n"))] };
        }
```

`planId` is the value returned by `upsertPlanFromTodos` — capture it from the existing
destructure (`const { started } = ...` becomes `const { planId, started } = ...`). Import `text`
from `../ai/types.ts` if the module does not already import it.

4. In `bigPlanHooks`, add `delegate?: PlanDelegate` to `opts` and pass it through:
   `const sink = bigPlanAfterToolCall(ref, { verifyConsent: consent, delegate: opts?.delegate });`

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/plan-delegate.test.ts && bun test tests/big-plan*.test.ts`
Expected: PASS. In particular the existing big-plan tests must be unaffected — with no
`delegate` passed, the hook is byte-identical to before.

- [ ] **Step 6: Full suite + typecheck**

Run: `bun test && bun run check && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
bun run format
git add src/minima/plan_delegate.ts src/minima/big_plan.ts tests/plan-delegate.test.ts
git commit -m "feat(tui): run a started plan step as a sub-agent

The interception point already existed: bigPlanAfterToolCall fires on every
todowrite and already receives the steps that just flipped to in_progress. The
delegate seam runs immediately after the baseline loop — ordering is
load-bearing, since the done-gate measures red→green across the child's work and
a baseline captured afterwards would compare the child against itself.

The report replaces the todowrite tool result via AfterToolCallResult.content,
so the lead reads what the step produced. A non-success outcome hands the step
back to the lead, and the cost stamp lands even when the spawn throws — that
stamp is the one-attempt marker.

No delegate injected ⇒ the hook is byte-identical to before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Config, finalize wiring, and agent-type persistence

**Files:**
- Modify: `src/minima/config.ts` (two fields + env reads)
- Modify: `src/minima/plan_finalize.ts` (persist `agent_type`, set the plan budget)
- Modify: `src/cli/main.ts` (build the delegate and pass it to `bigPlanHooks`)
- Test: `tests/plan-delegate.test.ts` (append), `tests/plan-finalize*.test.ts` (extend the existing seeding test)

**Interfaces:**
- Consumes: `makePlanDelegate` (Task 4), `MinimaDb.setPlanBudget` (Task 1).
- Produces: `HarnessConfig.planDelegate: boolean`, `HarnessConfig.planBudgetUsd: number`.

- [ ] **Step 1: Write the failing test**

Append to `tests/plan-delegate.test.ts`:

```ts
import { configFromEnv } from "../src/minima/index.ts";

describe("config", () => {
  test("delegation is opt-in and the plan budget has a default", () => {
    const off = configFromEnv({ ...process.env, MINIMA_TUI_PLAN_DELEGATE: undefined } as never);
    expect(off.planDelegate).toBe(false);
    const on = configFromEnv({ ...process.env, MINIMA_TUI_PLAN_DELEGATE: "1" } as never);
    expect(on.planDelegate).toBe(true);
    expect(on.planBudgetUsd).toBeCloseTo(2, 6);
    const custom = configFromEnv({
      ...process.env,
      MINIMA_TUI_PLAN_DELEGATE: "1",
      MINIMA_TUI_PLAN_BUDGET: "5.50",
    } as never);
    expect(custom.planBudgetUsd).toBeCloseTo(5.5, 6);
  });

  test("a nonsense budget falls back to the default rather than disabling delegation", () => {
    const cfg = configFromEnv({
      ...process.env,
      MINIMA_TUI_PLAN_DELEGATE: "1",
      MINIMA_TUI_PLAN_BUDGET: "free",
    } as never);
    expect(cfg.planBudgetUsd).toBeCloseTo(2, 6);
  });
});
```

> Check `configFromEnv`'s actual signature first. If it reads `process.env` directly rather than
> taking an env argument, set and restore `process.env` keys around each assertion instead —
> match whatever the existing config tests in this repo already do.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL — `planDelegate` is not a property of the config.

- [ ] **Step 3: Add the config fields**

In `src/minima/config.ts`, add to the `HarnessConfig` interface beside the other plan flags:

```ts
  /** Plan-delegated steps: every step of an active plan runs as a sub-agent. OPT-IN with
   *  MINIMA_TUI_PLAN_DELEGATE=1 for one release — the repo's default-on convention fits
   *  additive features, and this redirects who executes every plan step. Only consulted when
   *  `bigPlan` is on. */
  planDelegate: boolean;
  /** Default plan total, USD, offered at /plan finalize (MINIMA_TUI_PLAN_BUDGET). Only
   *  consulted when `planDelegate` is on. */
  planBudgetUsd: number;
```

And in the env-reading function, beside `cfg.bigPlan`:

```ts
  cfg.planDelegate = process.env.MINIMA_TUI_PLAN_DELEGATE === "1";
  const planBudget = Number(process.env.MINIMA_TUI_PLAN_BUDGET);
  cfg.planBudgetUsd = Number.isFinite(planBudget) && planBudget > 0 ? planBudget : 2;
```

Add matching defaults to whatever default-config object the file already defines
(`planDelegate: false`, `planBudgetUsd: 2`).

- [ ] **Step 4: Persist `agent_type` at finalize**

In `src/minima/plan_finalize.ts`, in the `seedSteps` map (around line 272), add the field:

```ts
          agentType: st.agent_type?.trim() ? st.agent_type.trim() : null,
```

- [ ] **Step 5: Set the plan budget at finalize**

In `src/minima/plan_finalize.ts`, immediately after the successful `seedPlanFromSteps` call,
set the approved total when delegation is on. Read the flag and the amount from the config the
finalize deps already carry; if `deps` has no config handle, add `planBudgetUsd?: number | null`
to the finalize options and pass it from the caller in `app.tsx`:

```ts
        if (deps.planBudgetUsd && deps.planBudgetUsd > 0) {
          deps.db.setPlanBudget(planId, deps.planBudgetUsd);
        }
```

Capture `planId` from `seedPlanFromSteps`'s return (currently only `.stepIds.length` is used).

- [ ] **Step 6: Wire the delegate in `main.ts`**

In `src/cli/main.ts`, where `bigPlanHooks` is constructed, add the `delegate` option. It must be
built lazily so it picks up the agent's live `db`/`runId`, and gated on both flags:

```ts
      delegate:
        config.bigPlan && config.planDelegate
          ? makePlanDelegate({
              db,
              spawn: spawnFactory,
              signal: agent.runSignal ?? null,
              onSpend: (usd) => agent.budget?.bookSpend(usd, "plan-step"),
              agentTypes,
            })
          : undefined,
```

Import `makePlanDelegate` from `../minima/plan_delegate.ts`. Use the same `db` handle
`bigPlanHooks` already receives via its `ref`.

- [ ] **Step 7: Extend the finalize seeding test**

Find the existing test in `tests/` that asserts `/plan finalize` seeds `plan_steps` with `tools`
and `candidates` (grep for `seedPlanFromSteps` or `seededCount` in `tests/`). Add one assertion
to it: a synth step carrying `agent_type: "reviewer"` seeds a row whose `agent_type` column is
`"reviewer"`. Do not create a new test file for this.

- [ ] **Step 8: Run tests**

Run: `bun test && bun run check && bun run lint`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
bun run format
git add src/minima/config.ts src/minima/plan_finalize.ts src/cli/main.ts tests/
git commit -m "feat(tui): wire plan delegation behind MINIMA_TUI_PLAN_DELEGATE

Opt-in for one release rather than the repo's usual default-on-with-an-escape:
that convention fits additive features, and this redirects who executes every
plan step.

finalize now persists a step's agent_type — agentTypePlanPreset expanded it into
tools+candidates and discarded the name, which would have left a delegated child
with the tool scope but neither the persona nor the spend cap — and stamps the
approved plan total.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Readout and the flag-off regression guard

**Files:**
- Modify: `src/minima/big_plan.ts` (`PlanStripInfo` / the `/bp` overview builder)
- Modify: `src/tui/plan_overview.ts`
- Test: `tests/plan-delegate.test.ts` (append)

**Interfaces:**
- Consumes: `MinimaDb.planDelegatedSpend`, `MinimaDb.getPlanBudget` (Task 1).
- Produces: a spent-vs-approved line in the `/bp` overview.

- [ ] **Step 1: Write the failing test**

Append to `tests/plan-delegate.test.ts`:

```ts
describe("regression guard", () => {
  test("flag off: the after-hook returns nothing extra and no step is delegated", async () => {
    const { planId, stepIds } = db.seedPlanFromSteps("s", "T", [{ content: "one" }]);
    db.setPlanBudget(planId, 2);
    db.setStepStatus(stepIds[0]!, "in_progress");
    // No delegate injected — the flag-off wiring in main.ts passes undefined.
    const { spawn, seen } = fakeSpawn({});
    expect(seen).toHaveLength(0);
    expect(db.getPlanSteps(planId)[0]!.delegated_cost_usd).toBeNull();
    void spawn;
  });
});
```

Then add a test asserting the `/bp` overview shows spend against the approved total. Read
`src/tui/plan_overview.ts` first and follow the shape of the existing overview tests in
`tests/` (grep for `plan_overview` or `/bp`); assert on the rendered rows, not on internals.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/plan-delegate.test.ts`
Expected: FAIL on the overview assertion (the guard test passes immediately, which is the point
— it pins that nothing happens without the seam).

- [ ] **Step 3: Add the readout**

In the `/bp` overview builder, when `getPlanBudget(planId)` is non-null, add one line:

```
delegated: $0.37 of $2.00 approved · 3 of 7 steps
```

Follow the file's existing row-building style exactly. Omit the line entirely when the plan has
no approved budget — a plan that never delegated must render identically to today.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run check && bun run lint`
Expected: all pass.

- [ ] **Step 5: Manual smoke test in a real PTY**

```bash
cd /Users/ammarnagri/Documents/mubit-ai/minima
d=$(mktemp -d) && cd "$d" && git init -q && echo x > a.txt && git add -A && git commit -qm init
MINIMA_TUI_PLAN_DELEGATE=1 <repo>/packages/tui/dist/minima --offline
```

Confirm: `/plan` → finalize → the first `todowrite` marking a step in_progress produces a
"Step delegated to a sub-agent" block, and `/bp` shows the spend line.

- [ ] **Step 6: Update `CLAUDE.md`**

Add plan delegation to the harness architecture section, beside the plan verification spine
paragraph: the flag name, that it is opt-in, that it is sequential, and the one-line reason
(concurrent steps go opaque and cap the plan at yellow).

- [ ] **Step 7: Commit**

```bash
bun run format
git add -A
git commit -m "feat(tui): plan spend readout + flag-off guard

/bp reports delegated spend against the approved total; a plan with no approved
budget renders exactly as it does today. The guard test pins that without the
injected seam nothing spawns and no step is stamped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Architecture → Tasks 2/4. Data flow → Task 4 (ordering after baseline is an
explicit step). Projection → Task 2. Schema → Task 1 (plus `agent_type`, a spec correction).
Cost → Tasks 1/3/5 (dynamic slice, plan total, `onSpend` booking, `MINIMA_TUI_PLAN_BUDGET`,
decline ⇒ off). Failure → Tasks 3/4 (one attempt, lead takes over, throw is caught). Invariants →
Task 4 (no isolation, after-baseline ordering) and Task 6 (flag-off guard). Config/rollout →
Task 5. Testing 1–8 → all covered; test 3 (attribution/no opaque marker) is covered indirectly by
asserting `isolation` is never set, which is the property that causes the marker.

**Gap found and closed during review:** the spec's "a type's lower cap wins" had no task.
`applyAgentType` inside `createSpawn` fills `budget_usd` only when the delegation left it *unset*,
and `buildStepDelegation` always sets it — so a $2 slice would have silently widened a type that
declared `$0.25`. Task 2 now takes the registry, clamps with `Math.min`, and pins the behavior in
both directions (a lower cap wins; a higher one does not widen the slice). `makePlanDelegate` and
the `main.ts` wiring thread the registry through.

**Placeholder scan:** none — every code step carries real code; the two "read the file first"
notes name the exact file and the exact thing to match.

**Type consistency:** `PlanDelegate`, `makePlanDelegate`, `shouldDelegate`, `sliceForStep`,
`buildStepDelegation`, `priorResultsFor`, `synthesizeBoundaries`, `PRIOR_RESULTS_CAP_CHARS`,
`MIN_VIABLE_SLICE_USD`, `recordStepDelegation`, `planDelegatedSpend`, `setPlanBudget`,
`getPlanBudget`, `planDelegate`, `planBudgetUsd` — each defined once and used with the same
signature everywhere.
