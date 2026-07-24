# W4.3 — Typed sub-agent outputs (MUB-205) — Wave 4, merges FIRST

> Plan pass 2026-07-24 against feat/boosting @ ba6eb32. Harness: `packages/tui`. Line numbers are anchors — re-verify at build time.
> **Orchestrator decisions folded in (D1/D2/D3 below) — not owner-blocking.**

**Anchor corrections (verified):** `output_format` is at `spawn.ts:61` (`## Return exactly\n${d.output_format}` in `delegationPrompt`); `spawn.ts:254` `const last = lastAssistantOf(child);` exact. Wave-3 `task.ts` docstring (commit 2833df0, ~:7-9, "frontier nodes run CONCURRENTLY under the fan-out semaphore") is current — preserve it.

**Key discovery:** the `task` tool is **NOT** in the tool-schema snapshot today — `builtinTools()` (`builtin.ts:75-92`) never constructs `taskTool`; it's registered separately in `main.ts:968-974`, and `tests/tool-schemas.test.ts` pins only `builtinTools()` + checkpoint/rewind. So the additive description change alone touches no snapshot.

**Orchestrator decisions (recorded, not owner-blocking):**
- **D1 = YES, pin the task tool's wire surface** in `tests/tool-schemas.test.ts` now (inert-spawn construction), closing the doctrine gap and making the W4.1 snapshot collision explicit/orderly.
- **D2 = strict authoring-time allowlist** — unsupported JSON-Schema keywords (`minimum`/`pattern`/`$ref`/`additionalProperties`/`oneOf`…) are REJECTED at authoring time, never silently unenforced (never fake a guarantee the harness doesn't provide).
- **D3 = keep the re-ask tags exactly `["phase:subtask"]`** — no new tag value (tags feed server cluster keying; a new value is a wire-visible surface change).

## Scope / Non-goals

**In scope**: additive `Delegation.output_schema` (JSON-Schema subset) on the `task` delegation contract · dispatcher-side enforcement in `createSpawn` (never prompt-only): extract JSON from child final text, validate, ONE re-ask quoting errors, then typed failure (`outcome:"failure"`) to the lead · validated object rides the result (new optional `ChildResult.data`; `text` becomes canonical JSON on the typed-valid path; dependent DAG nodes receive the object) · internal JSON-Schema-subset validator + fence-tolerant extractor, zero new deps · flag `MINIMA_TUI_TYPED_TASK` default ON · pin the `task` wire surface (D1).

**Non-goals**: no streaming/partial validation (final text only) · no retry beyond the single re-ask · no `output_schema` on plan-council delegations (`plan_council.ts` untouched, inert) · no DB surface change · no `executeDag`/loop/state change · no enforcement outside the declared subset (strict allowlist instead).

## Write-set (exact)

| File | Change |
|---|---|
| `src/tools/output_schema.ts` | **NEW** — subset validator, shape-check, JSON extractor, re-ask prompt builder (pure, no agent deps; under `tools/` so `task.ts` never imports from `minima/`) |
| `src/tools/task.ts` | `Delegation.output_schema?`, `ChildResult.data?`, `validateDelegations` shape-check (additive `opts?:{typed?}`), `TaskToolOptions.typedTask?`, `parameters` description (additive), docstring note |
| `src/minima/spawn.ts` | schema section in `delegationPrompt`, enforcement + re-ask + typed result assembly in `createSpawn` |
| `src/minima/config.ts` | `HarnessConfig.typedTask` + `configFromEnv` line (mirrors `editGuard`, ~:286) |
| `src/cli/main.ts` | ONE region: `taskTool({…})` options at ~:969-973 gains `typedTask: config.typedTask` |
| `tests/typed_task.test.ts` | **NEW** — behavioral tests importing ONLY pre-existing modules (the behavioral red) |
| `tests/output_schema.test.ts` | **NEW** — unit tests for the new module |
| `tests/config_env.test.ts` | append one flag test (~:224 pattern) |
| `tests/tool-schemas.test.ts` | add `taskTool` (inert spawn) to the pinned surface (D1) |
| `tests/__snapshots__/tool-schemas.test.ts.snap` | regenerated (new task entries auto-append; builtin roster unchanged) |

NOT touched: `src/agent/loop.ts`, `src/agent/state.ts`, `src/tools/builtin.ts`, `src/db/*`, `src/minima/runtime.ts`, `src/minima/plan_council.ts`.

## Flag: `MINIMA_TUI_TYPED_TASK`, default ON, `=0` opt-out

`typedTask: boolean` in `HarnessConfig`, `cfg.typedTask = process.env.MINIMA_TUI_TYPED_TASK !== "0"` (mirror of `editGuard`/`steer`/`memoryLedger`). Why a flag when `output_schema` presence already gates: the schema is model-authored, so once the tool advertises it the lead will attach schemas on its own; if enforcement misbehaves in prod (re-asks burning real spend, or over-strict validation flipping good children to `failure` and blocking their DAG dependents), the operator needs a kill-switch without prompt surgery.
- **ON, no `output_schema`** (regression axis): byte-identical to today — every new path is behind `d.output_schema !== undefined`.
- **OFF**: `output_schema` ignored end-to-end (shape-check skipped, field stripped before prompt-building, no validation/re-ask, prose result).
- **Wire surface is flag-independent**: the `delegations` description always mentions `output_schema` (the flag gates enforcement, never the schema JSON).

## Migration: NONE (confirmed)

DB at v21; nothing persists a new shape — the typed object lives in `ChildResult` (in-memory) and reaches the DB only as the existing schema-free text/decision rows. The re-ask books a second decision row under `agentId=childId` through the existing sink. Any DB need → escalate, don't improvise.

## Design (load-bearing points)

1. **Subset validator** in new `src/tools/output_schema.ts`. Supported keywords exhaustively: `type` (7 primitives or a union array), `properties`, `required`, `items`, `enum` (deep-equality membership); annotations `description`/`title`/`default`/`examples` accepted not enforced. Everything else rejected at authoring time (D2). Exports (pure): `schemaShapeErrors(schema): string[]` (recursive allowlist), `validateAgainstSchema(value, schema): string[]` (recursive, JSON-pointer-ish paths, capped at 8 errors), `extractJson(text): {ok,value}|{ok:false,error}`, `reaskMessage(schema, errors): string`.
2. **Delegation field + authoring check.** `Delegation` gains `output_schema?: Record<string,unknown>`. `validateDelegations` gains additive `opts?:{typed?}` (default true; caller passes `typedTask`). Typed-on + present → must be a plain object with empty `schemaShapeErrors`, else reject the batch naming the step (LEAD authored it — re-asking the child can't fix it). Typed-off → field not inspected.
3. **Validation runs in `createSpawn`** (dispatcher-side, needs the live child agent `executeDag` never sees). `const typed = parent.config.typedTask && d.output_schema != null`. Prompt side appends after `## Return exactly` (spawn.ts:61) a `## Output schema (STRICT)` section with the schema JSON, ONLY when the delegation carries `output_schema`; flag-off passes a stripped clone so the schema-less path builds the identical prompt object. Validation runs inside the existing `try` (after the first `promptRouted` + 422 pool-fallback, ~:221-243) so effort timer / abort / event forwarding / DB sink cover the re-ask; `finally` cleanup unchanged. Skipped when the first run failed / timed out / was parent-aborted / replied `BLOCKED:`.
4. **Re-ask: exactly one, no config.** On extraction/validation failure, `child.promptRouted(reaskMessage(...), {difficulty: d.difficulty, tags:["phase:subtask"]})` (D3) — same call shape as the pool-fallback retry, continuing the same conversation. Re-validate the new `lastAssistantOf(child)`; still invalid → typed failure, no third call. **Cost (traced):** each `promptRouted` books a meter row + a decision row under `agentId=childId`; `ChildResult.costUsd = child.meter.totals().actualCostUsd` includes the re-ask, `taskTool.totalCost` aggregates it — re-ask spend is fully visible money, never hidden (this is the TTSR-adjacent "no hidden retry spend" property for the task path). If `d.budget_usd !== undefined && spent >= budget` after the first run, the re-ask is SKIPPED with a budget-exhaustion note.
5. **Result assembly.** `ChildResult.data?: unknown` present iff enforcement ran and validated (track "validated" with a discriminated local — `null`/`false` are valid JSON). Typed-valid: `resultText = JSON.stringify(value, null, 2)`. Typed-failure: `outcome:"failure"`, `data` absent, `text` = failure summary + errors + truncated last reply; dependents block off `outcome==="failure"` exactly like any failed prerequisite. `executeDag` + summary/`details` byte-identical otherwise.
6. **Dependents** see `r.data` when present (rendered as `### step [outcome] (validated JSON)` + `JSON.stringify(r.data,null,2)`), else `r.text` as today. Existing `priorResults` plumbing — no change.
7. **JSON extraction** `extractJson`: (1) `JSON.parse(text.trim())`; (2) each ` ```json ` fenced block in order; (3) balanced-slice first `{`→last `}` then `[`→`]`. All fail → re-ask feed.
8. **Snapshot (D1):** `delegations` description gains additive `output_schema` text; the task tool is ADDED to `tests/tool-schemas.test.ts` (inert `taskTool({spawn: async()=>{throw…}})`), pinned identically in both flag states. Regenerate via `bun test tests/tool-schemas.test.ts` — new entries auto-append, builtin roster untouched; commit the diff deliberately, never hand-edit.

## Acceptance criteria (red→green, from `packages/tui`)

1. **Behavioral red (V3):** scratch worktree at base + ONLY `tests/typed_task.test.ts` (imports only pre-existing modules) → `bun test tests/typed_task.test.ts` FAILS with ASSERTION failures (not import errors): base `createSpawn` ignores `output_schema` so "re-asks once" sees callCount 1 not 2, "valid output parsed" sees `data===undefined`, "prompt carries schema" sees no `## Output schema`.
2. **Valid → parsed object:** `-t "valid"` → `data` deep-equals child JSON, `text` canonical, 1 call, `outcome==="success"`.
3. **Invalid → one re-ask then failure:** `-t "re-ask"` → callCount 2, 2nd request quotes errors + ONLY-JSON, 2nd-invalid → `outcome==="failure"` naming violations, no 3rd call, cost covers both.
4. **Schema-less regression:** `bun test tests/task.test.ts tests/spawn.test.ts` pass unmodified + a pinned-equality test (schema-less delegation → identical prompt + ChildResult).
5. **Flag:** `bun test tests/config_env.test.ts -t "TYPED_TASK"` (unset on, =0 off, =1 on) + a typed_task case proving flag-off ignores a present schema.
6. **Snapshot deliberate:** `git diff --stat` shows `.snap` changed only by new task entries; `bun test tests/tool-schemas.test.ts` green.
7. **Full gates + flag-off matrix:** `bun test && bun run check && bun run lint` green, and `MINIMA_TUI_TYPED_TASK=0 bun test` green.

## Test plan (hermetic, faux provider)

Reuse `registerFauxProvider` + scripted `/v1/recommend` mock + `leadAgent()` from `tests/spawn.test.ts:28-97`, `ConstJudge(0.9)`. `tests/typed_task.test.ts` cases: valid-first-try; fenced/prose tolerance; one-re-ask-then-success (asserts `reg.state.requests[1].user`); one-re-ask-then-clean-failure (callCount exactly 2); typed-failure-blocks-dependents; dependent-sees-object; schema-less byte-identity; flag-off-ignores-schema; BLOCKED-with-schema (no re-ask); budget-exhausted-skip. `tests/output_schema.test.ts`: per-keyword subset semantics, error formatting, cap at 8, `schemaShapeErrors` allowlist, `extractJson` ladder.

## Collision declarations

- `task.ts`/`spawn.ts`: claimed solely by this slice; merges FIRST → no rebase exposure.
- `tests/tool-schemas.test.ts` + `.snap`: shared with W4.1 (bgjobs) — but note the collision for W4.3 exists ONLY because D1 adds the task tool to the pinned surface. Resolution: merged code wins, REGENERATE the snapshot, never hand-merge. W4.1 rebases over ours.
- `config.ts` + `config_env.test.ts`: textual-adjacency with every Wave-4 slice (each appends one flag field + one `configFromEnv` line). Merging first makes ours the base.
- `main.ts`: ONE region (~:969-973 taskTool options). W4.1 also touches main.ts (job tool registration) — disjoint regions; both declared in preflight.
- Confirmed NO overlap with `loop.ts`/`state.ts` (W4.1/W4.2 battleground), `builtin.ts`, `db/*` (no migration; v22 stays free for W4.1), `runtime.ts`, `plan_council.ts` (constructs `ChildResult` literals — `data?` optional keeps them compiling).
