# Plan-delegated steps — design

**Date:** 2026-07-28
**Status:** approved, not yet implemented
**Scope:** `packages/tui` only. No server change; plan state stays client-side.

## Problem

A finalized plan is executed by the lead agent itself, one `in_progress` step at a time. Two costs
follow from that:

- **Context.** Every step's execution detail — file reads, tool output, dead ends — accumulates in
  the lead's context. Long plans degrade or compact, and the plan projection competes with the work.
- **Specialization is nominal.** A plan step can already name an agent type, but the type only
  expands into that step's `tools` + `candidates`, constraining the *lead*. The persona, the spend
  cap and the clean context the type describes never actually apply, because no child is spawned.

The harness already spawns sub-agents for the council (`/plan`) and the refutation pass (`/verify`),
and the `task` tool is registered for the lead. The machinery exists everywhere except the place
that would benefit most.

## Decisions

Settled during brainstorming; recorded because each one removes a large branch of the design space.

| Question | Decision |
|---|---|
| What is the win? | Context hygiene and specialization. **Not** wall-clock speed. |
| Which steps delegate? | Every step, when the feature is on. |
| Concurrency | **Sequential.** One step in progress at a time, exactly as today. |
| Cost bound | A plan total the user approves at finalize, sliced dynamically per step. |
| Driver | The lead drives; the harness intercepts the `in_progress` transition. |
| Step failure | The lead takes that step over inline. |
| Child context | Step contract + the results of steps it depends on. Never the plan projection. |

**Sequential execution is the load-bearing choice.** `file_changes` attribute to *the* in-progress
step and the schema permits exactly one. Concurrent steps would force worktree isolation, which
fires `recordOpaqueMarker`, which trips `Factors.blind`, which caps the plan's confidence tier at
yellow — surrendering green-tier gate verdicts, the only origin permitted to claim
`verified_in_production`. Wall-clock is not worth the product's only honest label source.

## Architecture

**New module: `src/minima/plan_delegate.ts`.** It owns one decision (does this started step
delegate, and with what) and one projection (`plan_steps` row → `Delegation`). It does not import
the spawner: `bigPlanAfterToolCall` gains an injected `delegate` seam alongside the existing
`verifyConsent`, and `main.ts` wires `spawnFactory` in. This keeps `big_plan.ts` free of a
dependency on `spawn.ts`, and makes the projection testable without spawning anything.

**Interception point.** `bigPlanAfterToolCall` already fires on every `todowrite`,
`upsertPlanFromTodos` already returns `{ started }` — the steps that just entered `in_progress` —
and the hook already runs each started step's baseline check there. `AfterToolCallResult.content`
replaces the tool result the model sees (`src/agent/loop.ts:524`). Together these are the entire
mechanism; no new dispatch path, no turn-loop change, and no instruction in prompt text (which
would be bypassable, contrary to *enforcement in the dispatcher, guidance in the prompt*).

## Data flow

Per step, in order:

1. Lead calls `todowrite` marking step N `in_progress` — unchanged.
2. `upsertPlanFromTodos` returns `{ started }` — unchanged.
3. Step N's **baseline check runs** — unchanged. This must stay before the child so the done-gate's
   red→green transition is measured across the child's work.
4. **New:** project the row into a `Delegation` and spawn it through the existing `SpawnFn`.
5. The child runs in the **parent workdir** — never a worktree. Its writes land as `file_changes`
   against step N automatically, because step N is the in-progress step while it runs.
6. The child's result replaces the `todowrite` tool result via `AfterToolCallResult.content`. The
   lead reads what the step produced, its outcome and its cost.
7. The lead marks the step completed; the existing done-gate runs the verify and writes the gate
   verdict — unchanged.

### The projection

A `plan_steps` row carries `content`, `verify`, `tools`, `candidates`, and possibly an agent type.
A `Delegation` additionally requires `output_format` and `boundaries`, which the plan format has no
field for. Rather than add two authoring burdens, the harness synthesizes both:

- `objective` — the step's `content`.
- `output_format` — fixed: what changed, and the result of running the step's `verify`.
- `boundaries` — generated from the *other* steps' content: those belong to other steps, do not do
  them.
- `tool_allowlist`, `candidates`, `agent_type` — the row's own fields, unchanged.
- `budget_usd` — the slice (below).
- prior results — the stored `result` of every **completed** step, most recent first, under a hard
  character cap, truncated at the boundary. All-of-them-uncapped would grow the child prompt
  linearly with plan length and give back the context-hygiene win this feature exists for;
  previous-step-only would starve a step that builds on something three steps back. The cap is the
  same shape the memory ledger already uses for its injected projection.

Steps stay linearly ordered, so the `Delegation.depends_on` field is left unset — prior results are
passed directly rather than through a graph the plan format does not have.

An agent type named by the step resolves through the existing `applyAgentType` inside `createSpawn`,
so precedence stays explicit field > type > default and a typed child takes the identical code path.

## Schema

One appended `MIGRATIONS` batch (append-only; shipped batches are never edited):

```sql
ALTER TABLE plan_steps ADD COLUMN result TEXT;               -- child's returned text
ALTER TABLE plan_steps ADD COLUMN delegated_cost_usd REAL;   -- realized child spend
```

`result` is what feeds `priorResults` to later steps — it must survive scroll, compaction and
restart, so it lives in the ledger and is re-projected, never held in context (*state in the DB,
projections in the context*).

`delegated_cost_usd` does double duty: it is the per-step cost readout **and** the
already-delegated marker (see Failure).

## Cost

**No estimator.** `/plan finalize` shows a plan total and the user accepts or overrides it — one
number per plan, defaulting from `MINIMA_TUI_PLAN_BUDGET` (default `$2.00`). **Declining the budget
turns delegation off for that plan**, which is exactly today's behavior: the lead executes every
step inline. There is no half-state where some steps delegate for want of money. A per-step estimator would mean
a throwaway `/v1/recommend` per step, minting `routing_decisions` rows that never receive feedback
— polluting the propensity record to produce a guess the user can simply be asked for.

**Slices are dynamic, not fixed at finalize:**

```
slice = (plan_total − spent_so_far) / steps_remaining
```

Recomputed before each spawn from `SUM(plan_steps.delegated_cost_usd)`, so cheap early steps leave
more for later ones and a static split cannot strand the last step. **A step's agent type cap wins
when it is lower** — a type declaring `budget_usd: 0.25` means it, and a generous plan total must
not silently widen it.

**Three ceilings, none replacing another:**

1. The session `BudgetLedger` — unchanged. Child spend already books against it via the `onSpend`
   callback on `taskTool`; the delegate path calls the same `agent.budget?.bookSpend(usd, ...)`, so
   plan-delegated spend is visible to `enforce` mode exactly like `task`-tool spend.
2. The step slice — enforced by the existing `shouldStopAfterTurn` in `createSpawn`.
3. The plan total — a plan-scoped ceiling read from the DB before each spawn.

The plan total is deliberately **not** reserved against the `BudgetLedger` up front. That would add
a reserve/release lifecycle to get wrong (abandoned plans leaking reservations, `/plan` competing
with the session's own spend) in order to enforce something a `SUM()` already answers.

**Exhaustion means two different things:**

- **Step slice exhausted mid-run** — `shouldStopAfterTurn` stops the child, which returns `partial`.
  That is a step failure: the lead takes it over inline. No new code.
- **Plan total exhausted** — the next step does not spawn at all. The plan stops, reports spent
  against approved, and waits for the user. Nothing is silently continued at the lead's expense.

**Readout.** Each delegated step reports its own cost in the transcript (`ChildResult.costUsd`), and
`/bp` gains a spent-vs-approved line. Because `delegated_cost_usd` is per-step in the ledger,
`/cost` demuxes plan spend from lead spend with no new plumbing.

## Failure

Any non-success child outcome — `failure`, `partial`, `aborted`, or a `BLOCKED:` reply — returns to
the lead with the child's output and the reason, plus an explicit note that this step is now the
lead's to finish inline with its own tools and full session context.

**One delegation attempt per step, ever**, enforced by the dispatcher rather than the prompt:
`delegated_cost_usd` is written on every attempt including failures, and a non-null value means the
step never spawns again. Without that guard, a lead that re-marks a step `in_progress` re-spawns it,
and one flaky step quietly consumes the plan's budget in a loop.

Abort is already wired: `parentSignal` propagates to `child.abort()` through existing code. The step
stays `in_progress` and the lead reports.

## Invariants preserved

- **Gate authority.** Baseline before the child, verify after, done-gate writes the verdict — all
  existing code. Because the child runs in the parent workdir with step N in progress,
  `recordOpaqueMarker` never fires and `Factors.blind` never trips, so the tier can still reach
  green. A delegated step's green gate is exactly as trustworthy as an inline one: the same shell
  command, the same working tree, the same evidence. `evidence_source="gate"` and
  `verified_in_production` provenance are untouched.
- **Children stay plan-blind.** `bigPlan` never inherits; the child receives its step contract and
  prior results, never the plan projection.
- **One `in_progress` step.** Unchanged.
- **Propensity integrity.** Children route normally (`pinned` stays false); a step pool is
  pre-request candidate assembly, never a post-hoc re-rank.
- **Recommend-only server.** No server change; plan state is never server-authoritative.

## Configuration and rollout

- `MINIMA_TUI_PLAN_DELEGATE=1` — **opt-in for one release**, then default-on once benched. The
  repo's convention is default-on with a `=0` escape, but that fits *additive* features; this
  redirects who executes every plan step.
- `MINIMA_TUI_PLAN_BUDGET` — default plan total, in USD, offered at finalize (default `2.00`).
- Gated on `config.bigPlan`: no plan spine, no delegation.
- With no agent types defined it still works — steps run as plain focused children.

## Testing

Hermetic throughout: faux provider, mocked `fetch`, in-process spawn. No network, no spend.

1. A `todowrite` starting a step spawns exactly one child, and its result reaches the tool result
   the lead sees.
2. **The baseline is captured before the child runs.** Reordering this breaks the gate silently.
3. The child's writes attribute to the in-progress step; no opaque marker is recorded; the tier can
   still reach green.
4. A failed child hands the step back to the lead, and that step cannot be re-delegated.
5. Slice math: dynamic recompute across steps; an agent type's lower cap wins.
6. Plan total exhausted → no spawn, the plan stops, nothing is silently continued.
7. **Flag off ⇒ byte-identical behavior.** The regression guard that matters most.
8. Children stay plan-blind: the child's system prompt contains no plan projection.

## Non-goals

- Parallel step execution. Explicitly rejected above; revisit only with a per-step attribution
  scheme that keeps green reachable.
- Merging a worktree child's work back into the parent tree. `createSpawn` currently
  `git worktree remove --force`s an isolation child's tree, discarding uncommitted changes; that
  gap is real but belongs to the `task` tool's isolation path, not here.
- A plan-step dependency graph (`depends_on` between steps). Steps remain linearly ordered; prior
  results are simply the completed steps.
- Any server-side change.
