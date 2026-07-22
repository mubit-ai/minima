# Harness Architecture — the internal agentic structure of `minima-tui`

The `minima` CLI (`packages/tui/`) is a TypeScript/Ink agent runtime on Bun. It is the
active harness: a coding agent whose every routed turn runs the Minima loop —

```
route  →  run  →  judge  →  feedback
```

— against the `/v1/*` contract, with its own SQLite persistence spine, a budget ledger,
a Big Plan verification spine (formerly "Ground Truth"), and a curated memory ledger.
This page documents the implemented architecture as of v0.13.x. (The 2026-07-02 design proposal it grew from is
preserved in [agent-core-architecture.md](agent-core-architecture.md); where the two
disagree, this page reflects the code.)

## Design principles (these constrain everything below)

- **State in the DB, projections in the context.** Anything that must survive scroll,
  compaction, restart, or a lying model lives in the SQLite ledger; the model sees only
  a compact re-injected projection.
- **Enforcement in the dispatcher, guidance in the prompt.** Plan/permission/gate
  guarantees are enforced by harness code at tool-dispatch or turn boundaries — never by
  prompt text, which is bypassable.
- **Feedback truth.** Realized usage only; no fabricated quality. A gate verdict maps to
  an outcome label; judge abstention stays `null`; `verified_in_production` comes only
  from user/repo/CI-origin gates, never agent-authored ones.
- **Recommend-only server stands.** Plan state is never server-authoritative.
- **Append-only migrations**, **`rec_id` discipline** (the sole local↔server↔Mubit join
  key), and **propensity integrity** (no client-side re-ranking; pins are pre-request
  candidate assembly, never post-hoc overrides).

## Module layout

| Directory | What it owns |
|---|---|
| `src/ai/` | LLM provider layer: `types.ts`, `stream.ts` (`stream()`/`complete()`), `registry.ts` (calling-side model catalog — distinct from Minima's routing catalog), `usage.ts` (tokens × price → USD), providers (`openai-compat`, `anthropic`, `google`, hermetic `faux`) |
| `src/agent/` | The stateful agent core: `loop.ts` (`agentLoop`), `agent.ts` (`Agent`), `tools.ts` (hook types), `modes.ts` (permission modes), `policy.ts` |
| `src/minima/` | The integration layer — this IS the harness (39 files): `runtime.ts` (`MinimaAgent`), `router.ts`/`client.ts`, `judge.ts`, `budget.ts`, `spawn.ts`, the Big Plan files (`big_plan.ts`, `big_plan_contract.ts`, `big_plan_factors.ts`, `confidence.ts`, `check.ts`, `stop_gate.ts`, `anti_spiral.ts`, `failure_kind.ts`), the memory files (`memory.ts`, `memory_ledger.ts`, `memory_scribe.ts`, `memory_dream.ts`), the plan files (`plan_turn.ts`, `plan_council.ts`, `plan_finalize.ts`, `plan_critic.ts`, `plan_refute.ts`), `diff_review.ts`, `meter.ts`, `schemas.ts` (wire mirror) |
| `src/tools/` | The agent's callable tools + `builtin.ts` registry |
| `src/db/` | Persistence spine: `minima_db.ts` (`MinimaDb`), `sink.ts` (event-stream → rows), `rehydrate.ts` (restore a run), `metrics.ts` (regret-vs-oracle) |
| `src/tui/` | Ink/React UI: `app.tsx` (main component + slash commands) + overlays |
| `src/session/` | Checkpoints (git-shadow worktree snapshots), `/undo` `/rewind`, resume re-verify, JSONL session store |
| `src/cli/` | `main.ts` — the single entry point; builds config/DB/agent, wires hooks, spawn, budget, scribe |

## The turn lifecycle — `MinimaAgent.promptRouted()`

`MinimaAgent extends Agent` (`src/minima/runtime.ts`). One routed prompt runs this
sequence:

### 1. Context assembly (reverted in a `finally` after the turn)

- **Mubit recall** — `memory.recall(content)` formats recalled evidence into a system
  prompt block.
- **Mode hint** — `modeSystemAppend(getMode())` for the current permission mode.
- **Big Plan projection** (when `config.bigPlan`, default on) — standing plan
  guidance plus `planProjectionFor(db, runId)`: the numbered plan of record, re-injected
  every turn so it survives compaction.
- **Memory-ledger projection** (lead agent only) — `memoryProjectionFor(db, runId)`:
  active + pinned curated memories under a hard char cap. Every *distinct* injected
  id-set is audited as an `inject` memory-event, so "what the model saw" is replayable.

### 2. The recovery-ladder loop (up to `1 + recoveryRungs` attempts, default 3)

Each rung:

1. **Budget gate** — in `enforce` mode, refuse before spend if `budget.exhausted()`.
2. **Route** — `router.recommend()` → `POST /v1/recommend`. Candidates are filtered to
   providers whose API key is present; a `/model`-pinned model bypasses Minima entirely;
   a `beforeRouteHook` may veto/override. The winner becomes `agentState.model`. With
   `autoEffort`, the server's classified difficulty picks the thinking-effort level.
3. **Reserve** — `budget.reserve()` holds a padded estimate (est-high × 1.5, or point
   estimate × 3) before any spend.
4. **Arm the stop stack** — one composed `shouldStopAfterTurn` closure: budget cutoff
   first, then the anti-spiral detector (doom-loop repeats / step-cap, fed by an
   after-tool ring buffer), then the stop-gate (strike-based stall detection).
5. **Run** — `super.prompt()` enters the base agent loop (§ Agent core). During dispatch
   `currentRecId` is set so any gate rows minted this rung carry the routing identity.
6. **Settle** — compute latency/turns/failure, read the **grounded verdict** for this
   rung (`groundedOutcomeFor(db, recId)` — the deterministic gate outcome, if any),
   classify transience, `budget.reconcile()` realized cost against the hold.
7. **Judge + feedback** — `feedbackSafely()` (see § Feedback truth).
8. **Persist** — `meter.record()` + `persistDecision()`: a `routing` event, a
   `routing_decisions` row keyed by `rec_id`, and the grounded-outcome stamp.
9. **Decide** — `stillFailing = hardError || judgeBelowThreshold || gateFailed`. If rungs
   remain, the **failure matcher** picks the intervention (§ Recovery ladder); the
   message list is rolled back to the pre-run index so the retry is clean. On
   exhaustion, a terminal `recovery` gate is written.

## Agent core (`src/agent/`)

- **`agentLoop`** (`loop.ts`) is a re-entrant async generator: prepare messages → stream
  the model → yield events → execute tool calls → append results → `turnEnd` → check
  `shouldStopAfterTurn` → drain steering/follow-up queues, up to `maxTurns` (default 50).
- **Tool dispatch** (`executeToolCalls`): validate params, then the **before-hook stack**
  (ordered; first `block: true` wins — this is where enforcement lives), then
  `tool.execute`, then the **after-hook stack** (folding — each hook sees the previous
  hook's modified result). Tools run in parallel via `Promise.all` unless any requested
  tool is sequential (the `task` tool is).
- **Registered hook stacks** (wired in `cli/main.ts` / `tui/app.tsx`, in order):
  1. **Permission hook** (TUI) — must run first.
  2. **Big Plan hooks** — the *done-gate* (before): refuses a `todowrite` that marks
     a step complete unless its `verify` command actually passes (red→green), enforces
     one-todowrite-per-message and the per-step tool allowlist; the after-sink keeps the
     plan/file-changes/gates ledger current.
  3. **Checkpoint hook** — pre-mutation git-shadow snapshot (powers `/undo`/`/rewind`).
  4. **Anti-spiral ring feed** — per-rung after-hook feeding the doom-loop detector.
- **Abort** is a first-class tree: `Agent.abort()` cancels the run controller,
  `MinimaAgent.abort()` also cancels the in-flight routing request, and each stream read
  races the abort signal so Esc interrupts mid-token. An aborted turn commits an
  explicit `[aborted by user]` stub — never a half-written message.

## Tools

The registry is `builtinTools()` (`src/tools/builtin.ts`): `read`, `write`, `edit`,
`apply_patch`, `bash`, `ls`, `glob`, `grep`, `todowrite` (done-gate-aware), `web_search`,
`web_fetch` (Exa when `EXA_API_KEY` is set, else DuckDuckGo). Filesystem tools are
confined to the configured workdir. Three tools are wired *outside* the registry: `task`
(sub-agents; added by `cli/main.ts` with spawn depth 0), and `question` / `exit_plan`
(plan-mode, wired by the TUI).

## Sub-agents (`src/tools/task.ts` + `src/minima/spawn.ts`)

The `task` tool takes a list of **delegations** — `{step_id, objective, output_format,
boundaries}` are required; optional `depends_on` (DAG edges), `effort`
(light/standard/deep → turn + wall-clock limits), `difficulty` (→ tier routing),
`tool_allowlist`, `budget_usd`, `isolation`.

- `validateDelegations` rejects missing fields, duplicate ids, dangling edges, and
  cycles before anything runs.
- `executeDag` runs independent frontier nodes **concurrently under a semaphore**
  (default 4); dependents wait; a failed dependency marks its dependents `blocked`.
- `createSpawn` builds each child as a **fresh `MinimaAgent`** sharing the parent's
  router/judge/memory but with its own cost meter, tools scoped to the allowlist (minus
  `task` at the depth cap — max depth 2), and `bigPlan: false` (the Big Plan spine never
  inherits into children). Each child routes through Minima independently — cost-aware
  routing applies **per worker**, not just at the top level.
- Per-node `budget_usd` becomes a running-cost stop; the parent's abort signal fans out
  to `child.abort()`; effort scales a wall-clock timeout (120s/300s/600s).
- `isolation: "workdir"` gives the child a temporary git worktree (with a dirty-tree
  warning, cleanup on exit, and fallback to the parent workdir on failure).

## Routing layer (`src/minima/router.ts`, `client.ts`)

`MinimaClient` is the typed `/v1/*` client (recommend, workflow, feedback, diagnose,
savings, calibration, strategies, memory-health, models, capabilities, health) with an
injectable `fetch` for hermetic tests. `MinimaRouter` maps the server's `RankedModel`
onto a callable harness `Model` and owns the fail-open discipline:

- **Routing must stay bypassable.** `--offline` or an unreachable server sets
  `offlineReason` and the run proceeds on the current model **with no feedback sent**
  (`allowOffline` defaults to true). An Esc during routing is an abort, not a
  degradation to offline.
- A pinned model (`/model`) skips the recommender entirely; explicitly provided
  candidate pools are hard constraints, never widened.
- `capabilities()` is cached per session and fails open to all-false;
  `diagnoseBrief()` fails open to null.

## Budget (`src/minima/budget.ts`)

`BudgetLedger` persists scopes in the `budgets` table with an append-only
`budget_events` audit. The cycle is **reserve → run → reconcile**: reservations are
guarded UPDATEs inside `BEGIN IMMEDIATE` (safe across processes), holds are padded
estimates, reconcile swaps the hold for realized cost, and `bookSpend` books unreserved
harness overhead (judge calls, scribe extraction) so *all* spend is on the ledger.
Modes: `shadow` (track), `warn` (notify at 50/75/90/100% thresholds, each fired once),
`enforce` (refuse new routed prompts when exhausted, stop a turn mid-run when realized
spend crosses the remainder, and thread remaining headroom into `/v1/recommend` as
`max_cost_per_call`).

## Recovery ladder (`src/minima/failure_kind.ts`)

After a failed rung, `makeFailureMatcher` classifies the failure and picks one of three
named rungs:

| Signal | Intervention |
|---|---|
| First grounded 🔴 gate verdict | **escalate** (`revise_step`) — exclude the failed model, re-route stronger |
| Gate still 🔴 after 2 rungs | **replan** — keep the model, revise the plan |
| Hard error classified transient (rate limit, 5xx) | **backoff** (`retry_step`) — same model, optional delay, **no feedback** (an infra fault must not read as model quality) |
| Judge-miss or non-transient error | **escalate** |

The **replan** branch is briefed before retrying: `collectFailureDiagnostics()` re-runs
the failing verify command and captures full output, and `router.diagnoseBrief()`
(→ `POST /v1/diagnose`) appends matching failure lessons from Mubit memory. Each retry
rolls the transcript back to the pre-run index; exhaustion writes a terminal `recovery`
gate.

## Big Plan spine

Formerly the "Ground Truth" spine — renamed in #208 ( `/gt`→`/bp`, `gt_*`→`big_plan_*`
with one-release compat aliases; the wire contract is unchanged). On by default
(`MINIMA_TUI_BIG_PLAN=0` opts out; legacy `MINIMA_TUI_GROUND_TRUTH` still honored). The
contract enums are frozen in `big_plan_contract.ts`: gate outcomes `verified | failed | unrunnable | unchecked`, confidence
tiers `green | yellow | red`, verifiers `deterministic | judge | user`, gate kinds
`step_check | milestone | stop | recovery`, check origins `pre_existing | agent_new |
user`.

- **Plan flow** — `/plan` runs a planner persona plus a deliberation council off the
  routing loop (`plan_turn.ts`, `plan_council.ts`); `finalizePlan` (shared by
  `/plan finalize` and the `exit_plan` tool) lints steps and auto-gates them. Each plan
  step carries a `verify` shell command and a recorded `baseline` (the check must be
  red *before* the work — a check that was already green proves nothing).
- **Verification** — `runCheck` (`check.ts`) executes verify commands deterministically
  (own process group, allowlisted env), consent-gated: the TUI injects a
  permission-backed checker; headless runs are fail-closed unless
  `MINIMA_TUI_ALLOW_VERIFY=1`.
- **The done-gate** — the before-hook that makes plans *enforced*, not advisory: a step
  cannot be marked complete unless its verify passes red→green. Verdicts land as rows in
  the `gates` ledger with the minting rung's `rec_id`.
- **Confidence tiering** (`confidence.ts`) — factors → tier: tampering → red; no
  discriminative check → yellow; check failed → red; agent-authored check with coverage
  gaps → red (the fabrication floor); a trusted check that passed → green. The tier
  drives the UI (🟢 glide / 🟡 flag / 🔴 stop) and, critically, feedback labeling: only
  **green-tier deterministic** verdicts may label an outcome as gate-verified.
- **Verification extras** — the **planning critic** (`plan_critic.ts`) runs one cheap
  completion at plan finalize flagging non-discriminative checks and hidden dependencies
  (advisory, never blocking); the **zero-context diff reviewer** (`diff_review.ts`)
  fires when a plan closes fully completed and reviews the run's whole diff with fresh
  eyes — an objection writes a yellow judge milestone gate (it can yellow a plan, never
  green it). `/verify` re-runs checks under a refutation brief; `/why` and `/bp` (Plan
  Overview; `/gt` is a deprecated alias) surface gate reasoning.

## Feedback truth (`feedbackSafely`)

Label precedence is strict — **deterministic gate > judge > telemetry-only**:

1. An infra failure sends outcome `failure` with `error_cause="infra"` and **no quality
   signal**.
2. A green-tier deterministic gate verdict labels the outcome with
   `evidence_source="gate"` — the only origin that may claim verified-in-production.
3. Otherwise a sampled LLM judge (`judgeEvery` × `judgeSampleRate`, default 15% of
   ungated turns; `MINIMA_JUDGE_SAMPLE=0` disables, `MINIMA_LLM_JUDGE=1` forces every
   turn) grades with
   `evidence_source="judge"`; unjudged turns ride as cost/latency telemetry
   (`evidence_source="none"`).
4. Transient failures short-circuit with **no feedback at all**.

Per-step process rewards ride the same request: `stepOutcomesFromGates` (`runtime.ts`)
maps the rung's gate rows — **deterministic/user verdicts only** (never judge, which is
model-adjacent self-assessment), last verdict per step wins, capped at 32 — into
`step_outcomes[]`. Every feedback carries realized `input_tokens` / `output_tokens` /
`actual_cost_usd` / `latency_ms` from the meter, never Minima's own estimate echoed
back. Feedback failures are logged and swallowed — bookkeeping never breaks the hot
path.

## Memory

Two distinct systems share the word "memory":

**Mubit (server-side, cross-user learning)** — `memory.recall()` before the turn and
`memory.recordOutcome()` after feedback are the harness's Mubit seams; harness trace
writes are partitioned to `lane: "harness"`.

**The memory ledger (local, curated, Track B)** — default on (`MINIMA_TUI_MEMORY=0`
opts out). Three tables (migration v12): `memories` (durable, bi-temporal — delete is
invalidation, never `DELETE`), `memory_events` (append-only audit), `memory_jobs`
(curation queue). Managed via `/memory` (list · add · pin/confirm/reject · delete).
Projection into the system prompt is lead-agent-only, ranked pinned > gate-cited >
recency under a 4000-char cap.

The model has **no memory-write tool** (the Letta split) — only the harness/user writes.
The sole automated writer is the **scribe** (`memory_scribe.ts`): a background curator
fed by SQL over the ledger (gate flips, verified failures, user corrections, judge/gate
disagreements — never the transcript), recurrence-gated (a pattern must recur before it
earns the one LLM extraction call, which routes through Minima tagged `memory:extract`
with its spend booked like judge spend), reconciled mem0-style (ADD/UPDATE/NOOP;
rejected rows never resurrect), and provenance-gated (only gate-cited candidates
auto-activate; the rest await `/memory confirm`). Triggers — session end, quiet timer,
startup leftovers — only *enqueue* `memory_jobs` rows; a crash-safe drain executes them
and requeues jobs orphaned by a crash. `memory_dream.ts` adds offline consolidation
gated on green-tier verified episodes.

## DB spine (`src/db/minima_db.ts`)

Event-sourced `bun:sqlite` (WAL), currently at **migration v14** — shipped batches are
append-only and never edited. `events` is the append-only source of truth; derived
tables key back to `event_id`/`rec_id`. `DbSink` subscribes to the agent event stream
and flushes buffered rows in one transaction at turn/agent end; writes fail open (a
degraded DB never breaks a turn); large tool results spill to blob storage.

| Table | Purpose |
|---|---|
| `projects` / `runs` | project identity → namespace; one row per run with lineage (`parent_run_id`, fork point) |
| `events` | append-only per-run event log (user/assistant/tool/system/routing) |
| `routing_decisions` | one row per routed prompt, PK `rec_id` — the local replay buffer for regret-vs-oracle metrics |
| `tool_calls` | every tool invocation (args + result, blob refs) |
| `budgets` / `budget_events` | budget scopes + append-only audit |
| `plans` / `plan_steps` | the Big Plan of record: steps with `verify`, `baseline`, check origin, tool allowlist |
| `file_changes` | every write/edit attributed to a step (`on_plan`/`off_plan` drift) |
| `gates` | verification verdicts: outcome, confidence tier, verifier, factors, `rec_id` identity |
| `user_signals` | user accept/reject/steer against a gate |
| `checkpoints` | git-shadow snapshots powering `/undo`/`/rewind` |
| `memories` / `memory_events` / `memory_jobs` | the memory ledger |

`rehydrate.ts` reconstructs a live agent from persisted events; `resume_verify.ts`
re-runs verifies on resume so a stale green never carries across sessions.

## Key environment flags

All default-on features follow the same rule: anything gated on the Big Plan lives
behind `config.bigPlan` (code; deprecated alias `config.groundTruth`), never behind
prompt text.

| Variable | Effect | Default |
|---|---|---|
| `MINIMA_URL` / `MINIMA_API_KEY` (or `MUBIT_API_KEY`) | routing endpoint + auth | `https://api.minima.sh` |
| `MINIMA_NAMESPACE` | memory lane | derived from the repo |
| `MINIMA_TUI_BIG_PLAN` (legacy `MINIMA_TUI_GROUND_TRUTH`) | Big Plan spine | on |
| `MINIMA_TUI_MEMORY` / `MINIMA_TUI_MEMORY_CAP` | memory ledger / projection cap | on / 4000 chars |
| `MINIMA_JUDGE_SAMPLE` / `MINIMA_LLM_JUDGE=1` / `MINIMA_JUDGE_MODEL` | judge sample rate (0 disables) / force every turn / model | 0.15 / off / `claude-haiku-4-5` |
| `MINIMA_TUI_STOP_STRIKES` / `MINIMA_TUI_SPIRAL_REPEATS` / `MINIMA_TUI_STEP_CAP` | stall + doom-loop detectors | 3 / 3 / 30 |
| `MINIMA_TUI_FAILURE_MATCHER` / `MINIMA_TUI_BACKOFF_MS` | recovery-ladder matcher / backoff | on / 0 |
| `MINIMA_TUI_PLAN_PREMIUM` / `MINIMA_PLAN_PREMIUM_MODELS` | premium pool for all plan-mode turns (council or not) | on |
| `MINIMA_TUI_PLAN_CRITIC` / `MINIMA_TUI_DIFF_REVIEW` / `MINIMA_TUI_AUTO_GATES` | verification extras | on |
| `MINIMA_TUI_ALLOW_VERIFY` | headless verify consent (fail-closed) | off |
| `MINIMA_TUI_INTERVIEW=1` | plan interview: ≤3 gated questions after a council round (verify commands → user-origin checks · budget/quality → routing profile `source='interview'` · prose → preference memories) | off |
| `MINIMA_TUI_EXPERIMENTAL` | umbrella: every default-off opt-in feature at once | off |
| `MINIMA_AUTO_EFFORT` | difficulty → thinking effort (experimental-covered) | off |
| `MINIMA_DB_PATH` / `MINIMA_HARNESS_DIR` | persistence locations | `~/.minima-harness/` |

`MINIMA_TUI_EXPERIMENTAL=1` covers default-off **opt-in features** only (currently
`MINIMA_AUTO_EFFORT`). An explicit per-flag value always wins — `=0` keeps a feature
off even under the umbrella. Consent gates (`MINIMA_TUI_ALLOW_VERIFY`: an umbrella
must never grant permission to execute shell commands) and diagnostic/rollback
switches (`MINIMA_TUI_PERF`, `MINIMA_TUI_BADGE`, `MINIMA_TUI_DEBUG_ANCHOR`,
`MINIMA_TUI_ANCHOR_LEGACY`) are exempt, and default-on opt-out flags are unaffected.
New default-off feature flags — including any currently unmerged — must resolve
through `optInFlag()` in `packages/tui/src/minima/config.ts` when they land so the
umbrella reaches them.

See [configuration.md](configuration.md) for the server-side variables and
[ground-truth-build-guide.md](ground-truth-build-guide.md) for the spine's build
history (written under the pre-#208 "Ground Truth" name).
