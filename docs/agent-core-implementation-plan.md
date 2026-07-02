# Minima Agent Core — Implementation Plan

Companion to `agent-core-architecture.md` (the *what/why*). This is the *how/when*: every work item,
dependency-ordered, with exact files and pass/fail gates. Paths are `packages/tui/src/` unless noted;
server items are `src/minima/`. Sizes assume one engineer; milestones are independently shippable.

**Ordering rationale.** M-A repairs live data corruption and pulls free routing wins (client-only,
zero server changes). M-B removes the process-global state that makes parallelism unsafe. M-C builds
the persistence spine everything downstream reads (provenance, metrics, resume). M-D adds the one
missing orchestration primitive (spawn). M-E/F add the two genuinely client-side routing pieces
(ledger, ladder). M-G+ are the moat.

---

## Milestone A — Feedback-truth hotfix + lever plumbing (P2-1a + P2-0) · ~3 d · ships as v0.5.x

**A1 — Poison stop (P2-1a, URGENT).** The client corrupts the server's learning loop today:
`router.ts:197` hardcodes `verified_in_production: true`; on judge abstention it sends
`quality_score: undefined`, which the server fabricates to **0.9** (`records.py:36`) and marks
high-importance (`feedback.py:105`), promoting spurious lessons every unjudged turn.
- `minima/router.ts` — `feedback()` takes `verifiedInProduction: boolean` (no default) + optional
  `notes`; never hardcode. Send `notes: "judged=false"` tag on unjudged turns (until the server's
  telemetry-only `judged` field exists).
- `minima/runtime.ts` — `feedbackSafely` passes `verifiedInProduction: false` (nothing verifies tests
  yet — honesty over flattery) and the judged discriminator.
- **A1b cost truth (C17):** `actual_cost_usd` = the **run-total** (sum of `AssistantMessage.usage.cost.total`
  over messages appended during this prompt), not last-assistant-only. Today multi-turn runs
  under-report and corrupt the server's observed-cost basis.
- *Gate:* unit tests — feedback request carries `verified_in_production:false` + `judged=false` note
  on abstention; multi-turn fake run reports summed cost == meter total.

**A2 — Lever plumbing (P2-0).** The server honors constraints the client never sends.
- `minima/router.ts` — `RecommendOpts` += `difficulty, expectedInputTokens, maxCostPerCall,
  minQuality, excludedModels, maxCandidates, allowLlmEscalation`; request mapper sends
  `constraints{max_cost_per_call,min_quality,excluded_models}`, `difficulty`,
  `expected_input_tokens`, `max_candidates`.
- `minima/router.ts` — map the four dropped response fields into `RoutingResult`:
  `recommendedActions, selectionPolicy, classifiedTaskType, classifiedDifficulty`.
- `minima/runtime.ts` — `promptRouted` opts += `difficulty, maxCostPerCall, minQuality,
  excludedModels` **[API CHANGE]**; `route()` computes `expectedInputTokens` from
  `agentState.messages` (chars/4 heuristic).
- `minima/client.ts` — every request sends `X-Minima-Client: <version>` header.
- *Gate:* recommend request snapshot test carries all levers; `RoutingResult` round-trips the 4
  fields; tsc/lint/tests green.

## Milestone B — Isolation prerequisites (P0a) · ~2 d · no behavior change

- **B1** `tools/todowrite.ts` — move module-level `todoState` into the `todowriteTool()` closure
  (per-instance list). Keep existing tests passing.
- **B2** `tools/{read,write,edit,glob,grep}.ts` — optional `workdir` base (mirror `bash.ts`) +
  **path confinement**: resolve target, reject escapes outside the base (`..`/absolute) with an
  actionable tool error. `builtinTools(opts?)` threads it.
- **B3** `cli/main.ts` — model-catalog sync becomes one-time bootstrap before agent construction
  (kills the `REGISTRY`/in-place `model.cost` mutation race).
- *Gate:* two tool sets in one process keep independent todos + distinct workdirs; escape attempts
  rejected; full suite green.

## Milestone C — Persistence spine (P0b + P1c) · ~1.5 wk

- **C1** `db/minima_db.ts` (new) — `bun:sqlite`, WAL, `busy_timeout=5000`, schema v1 (DDL in arch doc
  §5: `schema_meta, projects, runs, events, routing_decisions, tool_calls`), ordered idempotent
  migration runner keyed on `schema_meta.version`.
- **C2** DbSink — second `Agent.subscribe()` consumer persisting events; per-run
  `Map<toolCallId,{name,args}>` populated on `tool_execution_start` (loop emits name+args), consumed
  on `_end`; one transaction per turn; fail-open at run boundary (`runs.status='degraded'`, never
  kill the turn).
- **C3** DecisionRecord writer — in `promptRouted` after `feedbackSafely`, idempotent on `rec_id`
  (arch doc §5 sketch): ranked[] JSON, est/actual cost, `all_premium_cost_usd = max(ranked est)`,
  `quality, judged, outcome, turns, latency_ms`, `synced=0`. Offline/pinned rows get synthetic ids +
  `routed='offline'` label, excluded from reconciliation.
- **C4** Identity — `{project_key = repoIdentity(cwd), run_id = newId()}`; `agent.sessionId` stored
  as `runs.provider_session_id` (not PK); `startRun`/`finishRun` in `cli/main.ts`; flush at
  `endSession()`.
- **C5 (P1c)** Rehydration — `rehydrateRun(runId)` restores messages + CostMeter rows + promptsRun;
  `/resume` lists runs from DB; `/name` persists `display_name`; `/fork`/`/clone` copy events with
  fresh ids + remapped `parent_id`, **new synthetic rec_ids** (never duplicate the hosted join key).
- *Gate:* after a real routed run `SELECT count(*) FROM routing_decisions` == #prompts with non-empty
  ranked[]; kill -9 loses nothing committed; resume restores cost footer + routing history; `/name`
  survives reload; `writeDecision` idempotent under retry.

## Milestone D — Sequential spawn + metrics (P1a + P1b) · ~1.5 wk

- **D1** `tools/task.ts` (new) — `taskTool(spawn, {depth, maxDepth=2})`; `Delegation` schema
  (arch §3) with hard validation (required objective/output_format/boundaries; cycles/dangling/dup
  step_ids rejected); depth-1 **sequential** execution first. Default `SpawnFn` builds a child
  `MinimaAgent` (own pool/meter/workdir/systemPrompt/maxTurns-by-effort), abort tree
  (`parentSignal → child.abort()`, per-node wall-clock timeout), `ChildEvent` envelope forwarded to
  the parent bus. `builtinTools({spawn,...})` registers `task` conditionally; depth-exhausted =
  explicit tool result.
- **D2 (P1b)** `db/metrics.ts` (new) — `qualityPerDollar` (judged vs verified, graded coverage),
  savings vs `all_premium_cost_usd` and vs `configured_baseline`, `optimalCostRatio` + coverage over
  `routing_decisions`; `/cost` gains a `--run|--repo` breakdown; abstain/cadence-skip excluded from
  QpD, `quality=0` failures included.
- *Gate:* lead delegates a subtask; child routes on its own model in its own workdir and returns
  text; malformed/cyclic delegation rejected with actionable error; hand-computed QpD/savings match
  on a 3-row fixture; ChildEvents don't corrupt the lead transcript.

## Milestone E — BudgetLedger (P2-2) · ~1.5-2 wk

- `minima/budget.ts` (new) — scopes (session→goal→subtask), synchronous `reserve()` (multiplier over
  `est_cost_high` — it's a p75, under-covers by construction) / `reconcile()` on realized usage;
  graduated 50/75/90/100%: notice → warn → wrap-up-turn-then-abort; `budget_events` DB table.
- `agent/agent.ts` — `setShouldStopAfterTurn(fn|null)` **[API CHANGE]**; running-sum stop closure.
- `minima/runtime.ts` — per-call `maxCostPerCall` derived from remaining scope; **capability-gated**
  enforce mode (degrade to client pre-check unless server echoes honored constraints); dead-key
  reroute via `excludedModels`.
- TUI: budget footer (spent/reserved/remaining), `/budget` command; prompt-signal reminder of
  remaining budget. Shadow → warn → enforce staging.
- *Gate:* tight-cap E2E warns at 75/90, wrap-up answer at 100% then abort, no partial-tool
  corruption; two concurrent sessions on a shared ledger never jointly overshoot.

## Milestone F — Recovery ladder (P2-3) · ~1 wk

- `minima/ladder.ts` (new) — triggers: judge-fail (< τ, non-null), provider auth error, budget-deny,
  amber (`decision_basis='prior'` or confidence < ε), `collapse_guard_applied` (read
  `routing.warnings` programmatically). Rungs are **server-supplied** (`fallbackModelId`, `ranked[]`)
  — never re-ranked client-side (propensity integrity); fresh recommend per rung with
  `excludedModels`; per-rung feedback with `gradeOutcome`-consistent labels; reserve-before-rung;
  max 3 rungs/turn.
- *Gate:* forced cheap-model failure recovers on the fallback rung exactly once; never retries on
  null judge; zero `quality_outcome_mismatch` server flags; both rungs' rec_ids in the local DB.

## Milestone G — DAG fan-out (P2c) · ~1 wk

- Orchestrator executes `depends_on` frontiers under a **semaphore** (global + per-provider);
  parallel children = one `MinimaAgent` each (never re-enter the lead); opt-in worktree per editing
  node (confirm host `EnterWorktree` schema; non-git fallback = workdir); lead-owned merge node;
  partial-failure: failed node blocks dependents, returns partial summary.
- TUI: sub-agent tree panel from `ChildEvent` (separate panel; no transcript demux corruption);
  unsubscribe on completion; coalesce above fan-out threshold.
- *Gate:* "refactor N modules" fans out to N isolated children, merges deterministically; concurrency
  cap holds; abort cascades to in-flight children.

## Milestone H — Effort routing, Phase A (P2-4) · ~4 d

- **Gate-ordered:** provider effort mapping FIRST — anthropic `output_config.effort` (never
  `budget_tokens` on ≥4.6), openai_compat `reasoning_effort`, google `thinkingConfig` — then map
  `classifiedDifficulty`→`thinkingLevel` per prompt (staged default-off).
- *Gate:* Anthropic calls carry effort with zero 400s; effort varies per prompt with difficulty.

## Milestone I — Fleet metrics + judge activation (P2-5 + rest of P2-1) · ~4 d

- `/cost --fleet` + savings footer from `GET /v1/savings` (vs_premium / vs_declared; always send
  `baseline_model_id`); `LLMJudge` wired through the ledger (batch-priced, staged default-off,
  first-run notice); `verified_in_production` = tests-passed only; persist `FeedbackResponse`
  provenance ids; mark the data-epoch boundary.

## Milestone J — Server track (P2-6, Python, parallel from M-E) · Phase 3

Ordered: migration tooling (decisionlog can't add columns today) → `GET /v1/capabilities` /
`honored_constraints[]` echo → feedback integrity (plausibility clamps, per-key rate limits) →
telemetry-only `judged` field (kills 0.9 fabrication server-side) → org config + reasoner cap →
`set_effort` recommended_action → effort arms shadow-first → workflow budget allocator (override-wins
caveat C15) → governance endpoints. Canary + golden-replay + OPE gates per arch §4.11.

## Milestone K — Provenance MWR + hosted planner (P4a + P3c) · later

MWR projection over the DB → in-toto Statement + DSSE (unsigned bundle first, split verify:
integrity hard / reconciliation advisory); `export/resume/verify` CLI; redaction pass;
`CONTINUATION.md`; then `/v1/plan` (net-new server) + `recommendWorkflow` pricing.

---

## Session execution order (this pass)

A1 → A1b → A2 → B1 → B2 → B3 → C1 → C2 → C3 → C4 → C5 → D1 → D2, then E+ as time allows.
Each milestone: implement → unit tests → `tsc`/lint/full suite green → commit. PR per milestone
group; releases cut at stable points (A alone is release-worthy: it stops live data poisoning).
