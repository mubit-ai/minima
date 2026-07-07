<!--
Minima Next-Gen Agent Core — architecture proposal.
Produced 2026-07-02 from a two-phase research effort: (1) codebase grounding + external SOTA
research across 4 pillars, (2) 5 pillar designs each adversarially stress-tested (feasibility +
completeness) then integrated. All code seams verified against packages/tui/src on tui-rewrite.
Status: proposal / not yet implemented.
Revised 2026-07-02: Pillar 2 (cost-aware routing) fully re-grounded against the REAL server
engine (src/minima/recommender: engine/score/classify/escalation/propensity/decisionlog) +
fresh routing SOTA; adversarially re-verified. See the "Pillar deltas" subsection after §4
for surgical corrections to §§3,5-10. Urgent independent hotfix identified: P2-1a feedback-
poisoning stop (client hardcodes verified_in_production + null-quality successes).
-->

# Minima Next-Gen Agent Core — Definitive Architecture

Status: implementation-ready. Branch: `tui-rewrite`. All seams below verified against source at `/Users/shankhadutta/code/costit/packages/tui/src`. Every "already exists" claim that the adversarial reviews contradicted has been corrected in place; where a design asserted a no-op that is actually a real API change, it is flagged as **[API CHANGE]**.

---

## 1. Differentiation thesis

Minima becomes **the coding harness where a lead agent decomposes work into a deterministic, auditable DAG and routes _every sub-agent_ — not just the top-level task — to the cheapest model that clears a per-subtask ability bar under a shared, enforced budget, then emits a cryptographically signed, resumable work record that attests exactly what was done and what it cost.**

No shipping agent (Claude Code, Codex, Cursor, Devin, CrewAI) does cost-aware **per-worker** routing or ships a **cost-attested provenance bundle**. Minima already owns the three primitives everyone else bolts on after the fact: per-task cost-aware routing (`MinimaRouter.recommend` → hosted `/v1/recommend`), an outcome judge (`judge.ts`), and a realized-cost feedback loop (`/v1/feedback` + `CostMeter`), on top of a **re-entrant, per-instance agent loop** (`agentLoop` references zero global state; `Agent`/`MinimaAgent` are freely constructible). This is a **composition-and-persistence effort, not a rewrite.**

We do **not** chase raw SWE-bench/Terminal-Bench (ceiling is set by model+harness). We win on **regret-vs-oracle economics** and **quality-per-dollar**, and we make "the 15x multi-agent token tax pay for itself" a measured inequality, not a slogan.

---

## 2. System overview (one diagram in words)

Three tiers, one join key (`recommendationId`).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LOCAL TS HARNESS  (packages/tui)  — owns ALL execution-time mechanics        │
│                                                                               │
│   cli/main.ts  ── bootstraps ONCE: model catalog sync, SQLite DB open,        │
│                   run_id + project_key, top-level MinimaAgent w/ taskTool      │
│        │                                                                       │
│        ▼                                                                       │
│   MinimaAgent (lead)  ── promptRouted(): route → run agentLoop → judge →       │
│        │                 feedback → persist DecisionRecord (choke point)       │
│        │                                                                       │
│        ├── taskTool(spawn) ──► Orchestrator: PlanNode DAG, bounded fan-out,    │
│        │                        per-child MinimaAgent (own pool/workdir/budget)│
│        │                        judge-gated cascade, ChildEvent mux            │
│        │                                                                       │
│   BudgetLedger (session→subtask scopes, reserve/reconcile, minimum-wins)       │
│   MinimaDb (bun:sqlite WAL): events / runs / routing_decisions / tool_calls /  │
│              lessons(+vec)  ── SOURCE OF TRUTH for one run                      │
│   Provenance: MWR = pure projection over the DB + DSSE sign                    │
└───────────────┬───────────────────────────────────────────────┬──────────────┘
                │  POST /v1/recommend  (per-turn tier pick)       │  sync (idempotent
                │  POST /v1/recommend/workflow (per-step DAG tier)│   on rec_id)
                │  POST /v1/plan  (NEW: decompose+budget+tiers)   │
                │  POST /v1/feedback (realized cost/quality)      │
                ▼                                                 ▼
┌──────────────────────────────────────┐        ┌──────────────────────────────┐
│  HOSTED MINIMA "standard agent"       │        │  HOSTED DB / MEMORY           │
│  (ricedb, STATELESS per request)      │        │  Postgres + pgvector          │
│  - classify task_type/difficulty      │        │  - org-level savings aggreg.  │
│  - threshold_from_slider → τ           │        │  - Mubit cross-run lessons    │
│  - posterior-sample cheapest ≥ τ      │        │  - contextual-bandit training │
│  - est_cost band + ranked ladder      │        │    (experience replay)        │
│  - NEW /v1/plan: goal→step DAG+budget │        │                               │
│  Holds NO ledger, NO FS, NO worktrees │        │                               │
└──────────────────────────────────────┘        └──────────────────────────────┘
```

**The one-line boundary:** the hosted side makes **stateless meta-decisions** (what steps, what budget split, which tier per step); the local harness owns **everything stateful** (DAG execution, spawn, FS/worktree isolation, the budget ledger, cascade retry, event multiplexing, the durable record). See §8 for the precise contract.

---

## 3. Pillar 1 — Sub-agent dynamic workflows

**Grounded seams (verified).** `agentLoop(prompts, state, config)` (`loop.ts:51`) is re-entrant per `AgentState`. `Agent` is per-instance (`agent.ts:54-93`), exposes `subscribe()` (`agent.ts:122`), `waitForIdle()`, and `abort()`. `MinimaAgent extends Agent` binds its own router/judge/meter/memory/pool. `builtinTools()` (`builtin.ts:35`) has **no** `task`/`spawn` tool. `todoState` is a module singleton (`todowrite.ts:11`); the model `REGISTRY` is process-global. Only `bash` takes a `workdir` (`bash.ts:46`); `read`/`edit`/`glob` resolve via `expand()` against `process.cwd()`.

### Corrections folded in from the adversarial reviews (do not skip these)

The orchestration design shipped **two false seam claims** that must be fixed before P1:

1. **Abort/cancel is broken by construction.** `Agent.run()` creates its **own** `AbortController` internally (`agent.ts:161`) and exposes only `abort()`; `prompt()`/`promptRouted()` accept **no external signal**. The design's `SpawnContext.signal` cannot thread into a child. **Fix:** build an explicit abort tree — `SpawnFn` registers `parentSignal.addEventListener('abort', () => child.abort())`; node failure/timeout/budget-exhaustion aborts in-flight siblings via their `child.abort()`. Add a per-node wall-clock timeout.

2. **A single `MinimaAgent` cannot run two prompts concurrently** — `run()` throws `"agent is already running"` if `state.isStreaming` (`agent.ts:157`). Parallel fan-out therefore requires **one child `MinimaAgent` per parallel node** (which is the design), never re-entering the lead.

3. **`promptRouted` opts are `{taskType, slider, tags}` only** (`runtime.ts:112`) — there is **no** `difficulty` param today. Threading per-node difficulty is **[API CHANGE]**, not a no-op (see §4).

Additional completeness gaps folded in: max-parallelism **semaphore** (unbounded `Promise.all` → 429 storms + unbounded worktrees + Ink flooding); **DAG validation** (reject cycles, dangling `depends_on`, dup `step_id`); **partial-failure semantics** (a failed node marks dependents blocked, returns a partial merged summary); **path confinement** (workdir base via `expand()` is a convenience, not a sandbox — add a resolve-and-reject-on-escape check); **ChildEvent teardown** (unsubscribe on child completion) and **transcript demux** (the lead's single subscriber must not interleave children's `message_update` deltas into the flat React model — route ChildEvents to a separate tree panel only).

### Interfaces (corrected)

```ts
// The hard subtask contract. execute() rejects any delegation missing
// objective/output_format/boundaries with an actionable tool-error.
interface Delegation {
  step_id: string;
  objective: string;          // REQUIRED
  output_format: string;      // REQUIRED — what the child returns
  boundaries: string;         // REQUIRED — "do not touch X, that's another worker"
  tool_guidance?: string;
  depends_on: string[];       // DAG edges (parent step_ids)
  effort: "light" | "standard" | "deep";               // → maxTurns + fan-out size
  difficulty?: "trivial" | "easy" | "medium" | "hard" | "expert"; // → tier routing
  tool_allowlist?: string[];  // default = builtin minus 'task'
  budget_usd?: number;        // this node's slice of the shared ledger
  isolation?: "workdir" | "worktree" | "inherit";
}

// The client<->orchestrator seam. NOTE: signal is REAL now (abort tree).
type SpawnFn = (d: Delegation, ctx: SpawnContext) => Promise<ChildResult>;
interface SpawnContext {
  parentSessionId: string;
  parentRunId: string;        // for provenance + DB FK
  depth: number;
  budget: BudgetLedger;       // shared, synchronous reserve/reconcile
  onChildEvent: (e: ChildEvent) => void;
  parentSignal: AbortSignal;  // parent abort => child.abort()
  semaphore: Semaphore;       // global + per-provider concurrency cap
}
interface ChildResult {
  step_id: string; childId: string;
  text: string; costUsd: number; quality: number | null;
  outcome: "success" | "partial" | "failure" | "aborted";
  workdir: string;            // where edits landed (for merge)
}

interface ChildEvent {        // AgentEvents carry no agent identity; this demuxes them
  childId: string; parentId: string | null; depth: number;
  node: string;               // step_id
  event: AgentEvent;
}

interface PlanNode {
  step_id: string; delegation: Delegation;
  state: "pending" | "ready" | "running" | "done" | "failed" | "blocked";
  result?: ChildResult; attempts: number;   // cascade counter
}
interface Plan { plan_id: string; goal: string; budget_usd: number; nodes: PlanNode[]; }
```

**taskTool params:** `objectSchema({ delegations: "JSON array of Delegation" })`. `execute()`: JSON-parse → **validate graph** (cycles, dangling refs, dup ids, required fields) → build sub-`Plan` → execute frontier under the semaphore → return a merged per-node status summary. Registered **conditionally**: `builtinTools({ spawn, spawnDepth, maxDepth })` includes `task` only when `spawnDepth < maxDepth` (`maxDepth=2`). A child at `maxDepth` gets an explicit "depth exhausted" tool-result signal (not a silently missing tool).

**Default `SpawnFn`** constructs `new MinimaAgent({ config: childConfig(d), tools: scopedTools(d, workdir), maxTurns: turnsFor(d.effort), systemPrompt: delegationPrompt(d), meter: new CostMeter() })`, wires `child.subscribe(ev => ctx.onChildEvent({ childId, ... }))`, registers the abort listener, then `await child.promptRouted(renderObjective(d), { difficulty: d.difficulty })`.

### Isolation prerequisites (P0 — no behavior change)

- **[API CHANGE]** Move `todoState` into `todowriteTool()` closure so each agent owns its list. Keep backward-compat: default to a private per-call list, expose the accessor only when needed, so existing `tools.test.ts` callers don't break.
- **[API CHANGE]** Thread optional `workdir` base into `read`/`edit`/`write`/`glob`/`grep` factories (mirror `bash.ts:46`), **plus a path-confinement check** that resolves the target and rejects `..`/absolute escapes. Update every call site (`builtinTools`, tests).
- Model-catalog sync becomes a **one-time bootstrap** in `cli/main.ts` before any spawning (fixes the `REGISTRY`/in-place `model.cost` mutation race).
- **Worktrees are opt-in.** Confirm `EnterWorktree`/`ExitWorktree` schemas via ToolSearch before committing; define non-git and dirty-tree fallback (workdir-only). Merge = a deterministic **lead-owned merge node** in the DAG with a re-plan-on-conflict path.

---

## 4. Pillar 2 — Budget + cost-aware routing from an inferred pool

**Framing (the one-line correction to the old Section 4):** the hosted engine is not a thin classifier we build around — it is a complete, propensity-logged, calibrated contextual-decision system that already persists every decision durably (Postgres, 90-day) and already serves savings/calibration metrics. Pillar 2 is therefore **"activate and join"**: pull the dormant levers the shipping TS client never sends, consume the response fields it throws away, and add the only two things that are genuinely client-side — the **budget ledger** (stateful) and the **recovery ladder** (retry semantics). The single genuinely new *decision axis* is **reasoning effort**, which neither side routes today. One urgent addendum from the adversarial re-review: the live feedback loop is not merely dormant — it is **being poisoned today** (C14 below), and stopping that is the first shippable fix in this pillar.

### 4.1 What the server already is (authoritative, verified)

The recommend pipeline (`engine.py:85-369`): heuristic classify with caller-override precedence (`classify.py:131-134`) → optional cheap-LLM classify → cluster/fingerprint keys → hard constraint pre-filter capped at `max_candidates=8` sorted by capability prior (`engine.py:876-895`) → ANN recall + keyed lookup → neighbor-vote reclassification → time-decayed, seed-crowded-out, **IPW-debiased** aggregation (`aggregate.py:139-157`) → one homogeneous cost basis for the whole set (rescaled > observed > estimate, `score.py:65-92`) → **Beta-Bernoulli posterior** (pseudocount 2.5) remapped through a **lazily-refit isotonic calibrator applied on the hot path** (`engine.py:690-726`, refit every 600 s from ≥30 reconciled decisions, fit on the *raw* pre-bonus mean so the loop converges) → soft cost/latency filters → τ from slider (`0.55 + (cq/10)·0.37`, floored by `min_quality`, `score.py:182-193`) → cheapest-τ-clearing argmin with a τ-scaled **routing-collapse guard** over the 95 % credible interval (`engine.py:898-949`) → optional reasoner consult (`escalation.py`) → selection policy (deterministic argmin default; per-org Thompson with 128-sample MC propensities; per-org ε-softmax; advisory **shadow UCB** that never overrides) → **durable DecisionRecord** (Postgres in prod, 90-day retention) with full candidate snapshots, per-candidate selection propensities, exploration flags, shadow pick, and counterfactual cost baselines captured *before* filters (`decisionlog.py:49-88`, `engine.py:494-588`) → response carrying `ranked[]`, `fallback_model`, `est_cost_low/high` bands, `success_interval_width`, `threshold_used`, `selection_policy`, `recommended_actions`, `warnings`, `catalog_version`.

Feedback (`/v1/feedback`) writes evidence into Mubit memory (posteriors are *recomputed from recalled evidence per request*, not stored parameters), reconciles the decision-log row, defaults an idempotency key server-side (`outcome_idempotency_key(rec_id, chosen_model_id)`, `feedback.py:102-104`), accepts a divergent `chosen_model_id`, and works up to 90 days late via the decision-log context path (`feedback.py:56-65,230-279`). `GET /v1/savings` and `GET /v1/calibration` already compute dual-baseline savings, ECE, CUSUM drift, and routing-health rates (feedback_coverage, top_model_share, cheapest_model_share, cost_position, shadow_agreement) server-side (`savings.py`, `calibration.py:203-296`).

Precision notes on the above: the uncertainty-interval escalation gate exists (`escalation.py:50-53`) but `minima_escalation_mode` defaults to `"legacy"` (`config.py:66`) and prod does not set it — prod runs the 4-heuristic legacy triggers; the claim is "implemented but not enabled". And `Constraints.max_cost_per_call`'s schema description says "hard filter" (`schemas/common.py:52`) while the engine implements soft-filter+warning — the code is right, the docstring is misleading; flag for cleanup.

**Consequence:** the client must never re-rank, never run its own bandit, and never rebuild savings/calibration math. Client-side re-ranking corrupts the logged propensities and invalidates every future off-policy estimate.

### 4.2 Corrections ledger

**First pass — claims of the original Section 4, corrected:**

| # | Old claim | Corrected reality | Citation |
|---|---|---|---|
| C1 | "`Constraints.max_cost_per_call`/`min_quality` are dead pass-through fields" | Dead **only client-side**. Server fully honors both: cost filter at `engine.py:182-187`, `min_quality` as a τ floor at `score.py:191-192`. Plumbing them yields immediate server behavior with zero server work. | engine.py:182-207 |
| C2 | (implicit) cost cap is a hard filter | `max_cost_per_call` is **SOFT**: if nothing is affordable the server keeps the full set and appends warning `no_model_within_cost_budget` — it will happily recommend an over-budget model. Hard enforcement = client checks the warning. Same soft-fail for latency (`no_model_within_latency_budget`) and τ (`no_model_meets_threshold`). | engine.py:182-200, 941 |
| C3 | "maintain an `excludedProviders` instance field" for dead-key reroute | **No `excluded_providers` field exists server-side.** Constraints have `allowed_providers` + `excluded_models` only. Reroute by sending `excluded_models` (all models of the dead provider) or a complement `allowed_providers` list. | schemas/common.py:46-64 |
| C4 | Reserve = `estCostHigh ?? estCostUsd` with max_tokens as edge-case fallback | `est_cost_high` is **None on the 'estimate' cost basis** — cold start, mixed evidence, or whenever `require_prompt_caching` forces it (`score.py:156-157`). The max_tokens worst-case leg is the **common early path**, not the fallback. (Further corrected by C16.) | score.py:143-179 |
| C5 | "Authoritative pool = pass the `providerKeyPresent` set as `candidate_models`" (unqualified) | Server sorts by capability prior and **truncates to `max_candidates=8` before any cost scoring** — a big pool loses its cheap low-prior models before the cost ranking sees them. Raise `max_candidates` (≤ 64) when sending a big pool; LLMRouterBench shows curated subsets beat expansion — keep the pool curated, not maximal. | engine.py:894-895; schemas/recommend.py:26 |
| C6 | Cascade re-derives its rung ladder client-side from ranked[] | The server already ships the ladder: `fallback_model` = cheapest candidate with `predicted_success ≥ τ+0.05` (`engine.py:951-955`), and `ranked[]` is the full ordered ladder. Consume; never re-rank. Under Thompson/ε exploration the deterministic pick is deliberately demoted to `fallback` — "the natural retry". | engine.py:276,295,951-957 |
| C7 | `autoTuneSlider` tunes one knob | The slider moves **two** knobs: hard τ (0.55–0.92) *and* ranking λ (0.3–1.0). Clamping cheap under budget pressure drops τ toward 0.55; a quality floor that must survive budget pressure requires sending `constraints.min_quality` alongside. | score.py:182-193, 209-213 |
| C8 | Slider is a user control needing auto-tune "on top" | The shipping client exposes **no way to set the slider at all** — no CLI flag, no TUI command, zero-opts `promptRouted` call (`app.tsx:1422`). Every user routes at 5.0. Auto-tune replaces a control that effectively doesn't exist. | config.ts:49; app.tsx:103-127,1422 |
| C9 | "Cascade signal is frequently absent" (judge cadence) | `ConstJudge(null)` is wired permanently (`cli/main.ts:315`); `/judge` toggles cadence without instantiating the implemented `LLMJudge` (`judge.ts:54-89`). Judge quality is null on every turn except 0.0 on hard errors. **But see C14: "the loop learns nothing until the judge ships" was wrong in the dangerous direction.** | cli/main.ts:315; runtime.ts:244-260 |
| C10 | "Persist the routing DecisionRecord — nothing does" | False at system level. The server persists every decision durably with full candidate snapshots and propensities. What it lacks: session/run/turn linkage, judge per-dimension detail, locally-routed (offline/pinned) decisions, >90-day retention, tool traces. The client DB is the *session-scoped half of a two-sided record joined on `recommendation_id`* (§4.8). | decisionlog.py:49-88 |
| C11 | Cascade naming: "escalation" | Server "escalation" already means **reasoner-consult** (`escalation.py` gates a cheap-LLM re-rank of the routing decision). Client feature is renamed the **recovery ladder**. | escalation.py:1-83 |
| C12 | Routing decision space = model | Routing is two-axis: **(model, effort)**. `budget_tokens` is deprecated on Claude ≥ 4.6 and 400s on Opus 4.7+/Fable 5; the controls are adaptive thinking + `output_config.effort`. Neither Minima schema carries effort today. §4.5. | provider-authoritative; zero `effort` hits in schemas |
| C13 | (absent) cost model of rung re-runs | Prompt caches are **model-scoped and prefix-matched** — every rung on a different model pays a cold cache write (1.25–2× input) on the accumulated prefix. Rung math needs a switching-cost term; a "shepherding" rung (premium *hint* → cheap retry) is often cheaper than a premium re-run. | arXiv 2601.22132 |

**Second pass — claims of the reinforced design itself, corrected by the adversarial re-review (all verified against source):**

| # | Reinforced-design claim | Corrected reality | Citation |
|---|---|---|---|
| C14 | "All feedback fields currently null/absent; quality null ⇒ loop learns nothing" | **The loop is being poisoned today.** `router.ts:187-198` already sends `outcome`, `actual_cost_usd`, `latency_ms`, `iterations`, `chosen_model_id` — and **hardcodes `verified_in_production: true`** on every feedback. `runtime.ts:247-260` posts `outcome:"success"` with `quality:null` on every unjudged non-failed turn; server-side `records.py:16` substitutes default quality **0.9** for a null-quality success, `aggregate.py:119` feeds it into `weighted_success`, and `feedback.py:160-185` **promotes a high-importance lesson** (0.9 ≥ `minima_lesson_min_quality` 0.8, verified=true) on every unjudged successful turn. Fabricated 0.9 successes + spurious lessons, right now. | router.ts:187-198; records.py:16; feedback.py:160-185 |
| C15 | "`merged_over()` is tighten-only — a step can never relax a global cap" | **Inverted.** `merged_over` is override-wins: any step-set field replaces the base (`schemas/common.py:58-64`). A step *can* relax a global `max_cost_per_call`. Good for the workflow allocator (it can write per-step caps); fatal for any budget logic assuming the global cap binds. | schemas/common.py:58-64 |
| C16 | Reserve at `estCostHigh` on the observed/rescaled path | `est_cost_high` is the **p75** of a p25–p75 band (`score.py:150-151`, `q_high=0.75`) — reserving at p75 means ~25 % of calls exceed the reserve *by construction*, compounding near exhaustion where `max_cost_per_call = remaining` derives from the same number. Reserve with a multiplier (formula in §4.4.2), or add a server-side wider reserve quantile; keep p75 for display. | score.py:150-151 |
| C17 | Realized cost/latency semantics assumed sane | `runtime.ts:242-243` reports `lastAssistant().usage` — the **final message only**, not the run total, under-reporting multi-turn runs and corrupting the observed/rescaled cost basis and `/v1/savings`; `latencyMs` (`runtime.ts:132-139`) is the **whole multi-turn loop** incl. tool execution, so the observed-latency p75 that `max_latency_ms` filters against is loop-level. Define: `actual_cost_usd` = sum of all provider calls in the run (the ledger's running sum — reuse it); latency documented as loop latency (or switch to first-call latency) *before* ever sending `max_latency_ms`. | runtime.ts:132-139,242-243; engine.py:189-200 |
| C18 | "Client consumes exactly one response field pair"; RoutingResult diff lists many fields | Overstated. `router.ts:36-52,159-175` already maps `warnings`, `thresholdUsed`, `confidence`, `fallbackModelId`, `ranked[]`, `estCostLow/High`, `costBandBasis`, and the TUI renders warnings (`app.tsx:1424-1436`). Genuinely dropped: **`recommended_actions`, `selection_policy`, `classified_task_type`, `classified_difficulty`**. And `collapse_guard_applied` is on the display **hidden list** (`routing-warnings.ts:25`) — the force-judge trigger must read `routing.warnings` programmatically, never the rendered set. `client.ts` recommend opts also omit `max_candidates` (one-line fix). | router.ts:36-52; routing-warnings.ts:15-26 |
| C19 | "Apply `enable_prompt_cache` in adapters — otherwise realized cost sits above quote" | Stale for Anthropic: caching is **on by default** (cache_control on system/tools/last block, `anthropic.ts:200-226`) and `usage.ts` already prices cache read/write. Residual gaps: `cacheEnabled` config read nowhere, Google/openai_compat cache handling, and consuming `recommended_actions` for per-model decisions. | anthropic.ts:200-226 |
| C20 | Amber trigger "`decision_basis='prior'` with confidence 0.5" | **Unreachable.** Prior-basis candidate confidence is 0 (`score.py:35-38`; basis flips to `memory` whenever `weight_sum > 0`, `engine.py:795`) and `_overall_confidence` returns `min(conf, 0.5)` → ~0 (`engine.py:868-873`). Trigger on `decision_basis === 'prior'` alone, or `confidence < ε`. | score.py:35-38; engine.py:868-873 |
| C21 | Rung failure posts `outcome='failure'`, `quality_score=judgeScore` | Collides with the server consistency clamp: a failure with quality > 0.6 is clamped to 0.6 and flagged `quality_outcome_mismatch` (`records.py:39-50`, `feedback.py:69-82`). With a ladder threshold of 0.8, a 0.7 judge score posted as failure gets clamped+flagged on every escalation. Map outcome labels via `gradeOutcome` semantics (≥0.4 → `partial`, <0.4 → `failure`); the *escalation decision* uses the ladder threshold independently of the *outcome label*. | records.py:39-50 |

### 4.3 The definitive client-gap table

Server levers the shipping TS client (`packages/tui/src`) never pulls. The client today sends: `task` string, `candidate_models`, `namespace`, slider frozen at 5.0, `baseline_model_id` (when configured), plus feedback with `outcome`/`actual_cost_usd`(last-turn-only)/`latency_ms`/`iterations`/`chosen_model_id` and a hardcoded `verified_in_production: true` (C14, C17).

| Lever | Server behavior (citation) | Client status | Exact seam to pull it |
|---|---|---|---|
| `difficulty` | Authoritative override of the regex classifier AND multiplies expected output tokens into est_cost (`classify.py:131-134`; `engine.py:170-172`) | Accepted by `router.recommend` (router.ts:121) but unreachable — `promptRouted` opts lack it | Add `difficulty` to `promptRouted` opts (runtime.ts:112) → `route()` → `router.recommend`; orchestrator stamps it per `Delegation` node |
| `task_type` / `tags` | task_type picks the capability prior + calibration slice + cluster key; tags flow into Mubit recall as `env_tags` (`score.py:16-22`; `engine.py:323,410`) | Plumbed end-to-end, never supplied (app.tsx:1422 passes zero opts) | Stamp per-node task_type in orchestrator; stamp repo/tool tags at `MinimaAgent` construction (main.ts:311-317). Note cluster-key continuity: new stamps partially cold-start existing evidence — keep the old cluster key as a recall fallback for one release |
| `expected_input_tokens` | Sets the rescaled/estimate cost basis; absent → static default 1500 (`engine.py:169-173`) | Never computed, though `state.messages` is in hand when `route()` runs | Estimate tokens from accumulated context in `route()` (runtime.ts:205-211) — the cheapest fix for cost fidelity in long sessions |
| `max_cost_per_call` / `min_quality` / `max_latency_ms` | Cost soft-filter + warning; τ floor; observed-latency filter (`engine.py:182-207`) | Constraints object built with only `candidate_models` (router.ts:132-133) | Ledger writes `max_cost_per_call = min(perCallCap, scope.remaining().usd)` per call; `min_quality` from config/auto-tune floor; check `warnings` for `no_model_within_cost_budget`. `max_latency_ms` only after C17's latency semantics are fixed — units must match what feedback reports |
| Slider (`cost_quality_tradeoff`) | τ ∈ [0.55, 0.92] + ranking λ (`score.py:182-213`) | Frozen at 5.0; no flag, no command | `/slider` command + `--slider` flag + budget auto-tune (spent-fraction clamp), always paired with `min_quality` (C7) |
| `max_candidates` | Truncation happens **before** cost scoring (engine.py:894-895); ≤ 64 | Never sent; default 8; also missing from `client.ts` recommend opts (C18) | Send `min(pool.length, 16)` when the runnable pool exceeds 8; add the field in client.ts |
| `ranked[]` / `fallback_model` / `escalation_suggested:*` warnings | Full retry ladder + designed escalation rung on every response (`engine.py:951-957`) | Mapped into `RoutingResult` (router.ts:159-175) — **zero consumers of the ladder**; no retry ever | Recovery ladder (§4.6) at `promptRouted` level |
| `recommended_actions` | Prompt-cache directives so realized cost matches quote (`engine.py:855-865`) | Declared in schemas.ts:128, **dropped by the RoutingResult mapper** | Map into `RoutingResult.recommendedActions`; Anthropic caching is already default-on (C19) — the work is non-Anthropic cache handling + honoring per-model actions + reading `cacheEnabled` |
| `warnings` (full, programmatic) | Contract-level signals: budget-infeasible, collapse-guard, no-threshold, neighbor-classified | Mapped and partially *rendered*; `collapse_guard_applied` hidden from display (routing-warnings.ts:25) | Treat as machine-readable contract read from `routing.warnings`: `no_model_within_cost_budget` → ledger gate; `collapse_guard_applied` → force-judge this turn; `no_model_meets_threshold` → pre-arm ladder |
| Judge quality signal | `quality_score` shapes future posteriors; `verified_in_production` triggers lesson promotion (`feedback.py:105,160-185`) | **Actively harmful today (C14):** null quality → server-default 0.9 + hardcoded verified=true → spurious high-importance lessons every unjudged success | P2-1: wire `LLMJudge` (judge.ts:54-89) in cli/main.ts:315; `verified_in_production` = tests-passed; unjudged turns send telemetry-only feedback (§4.7) |
| `latency_ms` on feedback | The only way `max_latency_ms` ever bites — observed-only p75, min 3 obs (`engine.py:189-200`) | Sent, but loop-level (C17) | Fix semantics first; then send the constraint for interactive turns |
| `idempotency_key` / `notes` / FeedbackResponse | Server already defaults the key (`feedback.py:102-104`); response returns `reinforced_entry_ids`, `updated_confidence`, `reflection_triggered`, `lesson_promoted` | Key server-defaulted (explicit key adds little); `notes` never sent; response awaited and **discarded** (router.ts:187-198) | Send `notes` (rung index, abort reason, judged marker); persist FeedbackResponse ids into local `routing_decisions` for the provenance join |
| `allow_llm_escalation` / `explain` | Server may spend reasoner tokens on the org's behalf (prod: gemini-3.5-flash; interval-gate mode implemented but prod runs `legacy`); `explain` = richer rationale | Never set; no per-call opt-out exists client-side | Expose both on `RecommendOpts`; `explain=true` for a "/why" TUI answer; org-side reasoner cap in §4.11 |
| `recommendWorkflow` | Live per-step pricer with per-step constraints + all-premium counterfactual (`recommend.py:28-66`) | Fully typed (client.ts:133), zero call sites | Pillar-1 planner prices the DAG in one round trip. **Caveats:** sequential fan-out, `depends_on` dead, `workflow_recommendation_id` minted and forgotten — not a join key; `merged_over` is override-wins (C15) |
| `GET /v1/savings` / `/v1/calibration` / `/v1/strategies` | Dual-baseline savings, ECE/CUSUM/routing-health, memory-lesson explainability — computed server-side today | Implemented in client.ts:146-159, never called; `/cost` shows a lost-on-exit meter | `/cost --fleet` + savings footer call the server; local meter stays session-scoped |
| `catalog_version` | Returned on every recommend (`schemas/recommend.py:94`) | Ignored — stale client prices silently corrupt local reserve math | Compare to local; refetch catalog on mismatch; prefer server `est_cost_high` whenever present |
| Reasoning effort | **No server field exists** | `thinkingBudgets` never configured: every non-off level = `budget_tokens:1024` on Anthropic (**400s on Opus 4.7+/Fable 5**, anthropic.ts:226), bare `includeThoughts` on Google, no-op on openai_compat; `--thinking` parsed but dead (main.ts:196-197) | §4.5 — the new lever, with a hard ordering constraint |

### 4.4 Budget architecture (revised for the real server)

**Division of labor.** The server provides: calibrated `predicted_success` for budget math (expected-cost-of-success = `est_cost / predicted_success`), per-candidate cost bands, the per-call soft cost filter + `no_model_within_cost_budget` infeasibility signal, and counterfactual baselines for the savings ledger. The client owns everything stateful: the ledger, reserve/reconcile, graduated interventions, the kill switch — the server holds no running-spend state per request (no budget field in any server schema).

**Threat model (stated honestly, it wasn't before).** Auth is pure pass-through (`api/auth.py`): whoever holds the Mubit key *is* the org; no per-user identity exists. The ledger is client-side and client-trusted: a modified client can ignore budgets, lie in feedback (`actual_cost_usd` validated only `ge=0`, `schemas/feedback.py:17`), or flood feedback (**no rate limiting exists anywhere in `src/minima/api`**). Therefore: **the budget ledger is a safety rail for the honest user, not a billing control** — billing-grade caps belong at the provider-key layer (org-owned proxy keys / provider spend limits). Server-side integrity hardening is specified in §4.11 (feedback plausibility clamps, per-key rate caps, advisory org spend ledger, CUSUM poisoning detection). Similarly honest: until the org-config surface (§4.11) exists, budgets/floors/judge cadence are **per-developer courtesy settings**, not org policy — a team lead cannot set "eng org: $50/day, min_quality 0.7, no reasoner spend", and local config is trivially editable.

Retain the corrected interfaces (`BudgetScope`/`BudgetLedger`, session→subtask scopes, synchronous reserve/reconcile, running-sum reconcile across turns, post-turn enforcement honesty, `setShouldStopAfterTurn` **[API CHANGE]**), with these upgrades:

1. **Server-enforced per-call cap — with capability confirmation.** Every recommend call carries `max_cost_per_call = min(perCallCap, scope.remaining().usd − safetyMargin)`. On warning `no_model_within_cost_budget`: **enforce mode** → do not run; surface "budget-infeasible: cheapest candidate $X > remaining $Y", offer approve/stop; **warn/shadow** → run + log. **Soundness caveat:** Pydantic `extra="ignore"` means an old server silently drops unknown constraint fields — the client cannot distinguish "honored" from "ignored", and the gate keys off a warning an old server will never emit. **Rule: enforce-mode budget gating requires capability confirmation** (`GET /v1/capabilities` or `honored_constraints[]` echo, §4.11); otherwise degrade to a client-side pre-check against `est_cost_high`.
2. **Corrected reserve (C4 + C16):**
```ts
const bandHigh = routing.costBandBasis ? routing.estCostHigh! : null;  // p75 of a p25–p75 band — NOT worst-case
reserve.usd = bandHigh !== null
  ? Math.max(K_BAND * bandHigh, routing.estCostUsd)   // K_BAND ≈ 1.5–2: p75 under-covers ~25 % of calls by construction
  : (expectedInputTokens * model.cost.input + model.max_tokens * model.cost.output) / 1e6;
// The max_tokens leg is the COMMON path at cold start / require_prompt_caching — not a fallback (C4).
// Later server assist: a wider reserve quantile (q_high=0.9/0.95) for reserve purposes; p75 stays for display.
// Prices come from the local catalog: check response.catalog_version, refetch on mismatch (stale prices ⇒ wrong reserves).
```
3. **Realized-cost/latency semantics (C17), fixed at the source.** Feedback `actual_cost_usd` = the ledger's running sum over *all* provider calls in the run (also fixes the existing under-report at `runtime.ts:242-243`); latency documented as loop latency until/unless a per-call figure is added. This is a P2-0 item — it protects the observed/rescaled cost basis and `/v1/savings` before anything else turns on.
4. **Budget as a prompt signal, not just a hook.** Render a per-turn system-reminder from `scope.remaining()` ("Budget: $0.42 of $2.00 remaining, 3 turns used"). BATS (arXiv 2511.17006): a visible budget tracker cuts resource use ~31 % at equal accuracy. Cheapest budget feature in the design. On supported Claude models additionally mirror `remaining()` into native `output_config.task_budget` (beta `task-budgets-2026-03-13`, min 20k tokens, Fable 5/Opus 4.7/4.8 only) as soft self-pacing — hooks stay the hard stop.
5. **Never ask the model about feasibility or prices.** BAGEN (arXiv 2606.00198): capability↔budget-awareness r = 0.35, systematic over-optimism, 47 % interval-calibration ceiling; CostBench: frontier models collapse on mid-task cost changes. Infeasibility detection is harness-side.
6. **ProgressMonitor (orthogonal kill signals).** Diminishing-returns: last 3 turns added <500 tokens of non-boilerplate AND <$0.01 tool work → `NoProgress`. Repeated `(tool, argsHash)` 3× → nudge injection, 5× → `StuckLoop` fail. Early-stopping doomed trajectories recovers 28–64 % of failed-trajectory spend.
7. **Graduated interventions:** 50 % → log. 75 % → warn + slider clamp cheaper **+ send `min_quality` floor** (C7). 90 % → approval gate (interactive) / warn+continue (non-interactive, decided) + tighten `max_cost_per_call`. 100 % → **wrap-up turn, then abort**: inject a wrap-up instruction and allow ONE pre-reserved, capped, cheapest-pool-model turn that emits a best-effort answer + state of work (anytime pattern, BRPO arXiv 2505.13438), then `agent.abort()`. Minima ends with "best answer within $X", never a bare death.
8. **Hard invariant caps + upgrade honesty.** `BudgetLimits` null ≠ unlimited: backstop `MAX_HARD_BUDGET_USD` (e.g. $100/session), 24 h wall clock, iteration cap. Because these defaults can abort a long run that used to complete, ship them behind a **versioned config migration** (`config_version` + upgrade function), a first-run notice showing new defaults, and a `minima doctor` command printing effective config, server capability level, and active levers.
9. **Concurrent-process ledger.** Two sessions on one machine (or parallel subtask scopes) share an org budget but the ledger is per-process. Single-writer ledger via a shared per-user SQLite file with `BEGIN IMMEDIATE` transactions; scope arithmetic for N concurrent sessions is defined as per-session sub-caps carved from the shared limit at open (first-come, remainder-split), never optimistic double-spend.
10. **No-bypass rule + audit.** Every model call — judge calls, DART probes, recovery-ladder rungs, wrap-up turns — routes through the ledger; a lint rule greps for provider-call sites not wrapped by the ledger, and any new bypass is a reviewer-flagged diff. `budget_events` audit table (reserve/reconcile/deny/approve/override rows keyed scope + `rec_id`) joins the Pillar-3 DDL.
11. **Offline/degraded-server mode (defined, not implied).** When `/v1/recommend` times out or 5xxes: run the pinned/last-good model; the ledger still enforces, with a client-side cost pre-check against the last cached est band replacing the warning-based gate; the ladder degrades to same-model retry only; decisions are written locally flagged `routed=offline` (§4.8 row type) and excluded from OCR/reconciliation. A client-side rung/probe cap (max 3 rungs/turn) bounds request amplification even when the server is healthy.
12. **Positioning honesty:** budget caps are a free-tier commodity (LiteLLM ships them for $0). The ledger is trust infrastructure that makes autonomous runs safe; the monetizable asset is the routing intelligence + provable savings metric. Copy the NotDiamond/OpenRouter single 0–10 dial as the only user-facing knob over `{max_cost_per_call, min_quality}`.

### 4.5 Reasoning effort as a routed lever: the arm space is (model, effort)

**Ground truth (verified against the current API reference):** on Claude ≥ 4.6 `budget_tokens` is deprecated and returns 400 on Opus 4.7+/Fable 5; the controls are `thinking:{type:"adaptive"}` + `output_config.effort` (low…max). OpenAI exposes `reasoning_effort`. Test-time compute is a first-class per-query cost axis (arXiv 2507.02076). Minima routes over models only — zero `effort` hits in server schemas or `mapping.ts`/`router.ts` — and the client's 6-level `ThinkingLevel` degrades to a broken boolean (`anthropic.ts:226` sends `budget_tokens:1024`, Google bare `includeThoughts`, openai_compat no-op, `--thinking` parsed but never applied).

**Hard ordering constraint (this is a gate, not a task):** today nothing 400s only because `thinkingLevel` defaults `"off"` and `--thinking` is dead (`cli/main.ts:196-197`). The moment *any* code path sets `thinkingLevel ≠ off` — honoring `--thinking`, or Phase A's difficulty→effort mapping — every Anthropic thinking call fails. **The provider mapping fix must merge before any code path can set a non-off thinking level.**

**Phase A — client-only, zero server change (ship first):**
- Fix the provider mapping: Anthropic → adaptive thinking + `output_config.effort` (**never** `budget_tokens` on current models); openai_compat → `reasoning_effort`; Google → `thinkingConfig` budget. Then honor `--thinking`.
- Per-prompt effort in `route()`: map the server's already-returned `classified_difficulty` (`schemas.ts:121-122` — currently dropped by the mapper, C18) → ThinkingLevel (`trivial/easy→low, medium→medium, hard→high, expert→xhigh`), replacing sticky global UI state. Difficulty the client *sends* (§4.3) round-trips as the effort it *applies*. Ship default-off-then-opt-out (same shadow→warn→enforce staging discipline as budget — auto-effort changes spend on upgrade, §4.11).
- Optional cold-cluster probe: DART-style two-cheap-draft agreement (arXiv 2606.23181; +22.5 pts code reasoning at 51–63 % fewer thinking tokens) as the difficulty feature when `decision_basis='prior'` — two Haiku-class calls, priced through the ledger, counted against the 3-extra-calls/turn amplification cap.

**Phase B — server interim, zero schema change:** extend `recommended_actions` (plain string list, `engine.py:855-865`) with `set_effort:<level>` derived from classified difficulty + observed token yield. The client already consumes `recommended_actions` for caching (§4.3); effort rides the same seam.

**Phase C — server proper: (model, effort) arms.** Implement effort tiers as catalog variants (`claude-opus-4-8@medium`) so **everything applies unchanged per arm**: Beta posteriors, Thompson propensities, isotonic calibration, IPW, the decision log — keyed per (lane, cluster, model, effort). Price tiers from observed output-token multipliers in the feedback loop. Response adds `effort` to `RankedModel`. The engine can then express *"cheap model + high effort"* vs *"expensive model + low effort"*. Launch discipline (§4.11 gaps made explicit): (a) **requires DB migration tooling first** — `CREATE TABLE IF NOT EXISTS` never adds columns, so per-arm fields silently won't persist on existing prod Postgres; (b) **shadow-first** — the advisory shadow slot already exists; log `shadow_effort` for weeks before serving; (c) **cold-start math**: 3–4 tiers triple the arm space, `max_candidates` binds sooner, calibration slices thin below the ≥30-decision refit floor, seeding covers none of it — launch 2 tiers/model, inherit the base model's posterior as the variant prior (shrinkage), slice-sufficiency check before per-arm calibration applies; (d) **old-client compat**: v0.4.x binaries can't map `model@effort` ids in `mapping.ts` — serve plain model ids below a client-version floor (`X-Minima-Client` header, §4.11).

### 4.6 The recovery ladder (client) on top of server escalation

**Naming (C11):** server *escalation* = reasoner-consult on the routing decision (`escalation.py`; OFF by default; prod runs `legacy` trigger mode — the interval gate at `escalation.py:50-53` is implemented but not enabled). Client feature = **recovery ladder**. The server has no judge-fail→next-ranked retry anywhere — the ladder is genuinely the client's job; the server's contribution is the *rungs*.

**Rungs come from the server, never re-ranked (C6):** rung 0 = `recommended_model`; rung 1 = `fallback_model` (cheapest with `predicted ≥ τ+0.05` — the designed retry; under exploration it is deliberately the deterministic pick); rungs 2+ = `ranked[]` order. A **shepherding rung** (arXiv 2601.22132) sits between: request a premium-model *plan/hint*, retry on the cheap model — pays for guidance instead of a premium re-run and avoids the cold-cache write. **Invariant: max 3 rungs per turn** (amplification cap, §4.4.11).

**Triggers (all at the `promptRouted` level, since `route()` returns before the loop runs):**
1. Non-null judge score < threshold (null/abstain = never escalate). **Prerequisite: wire `LLMJudge`** — the entire ladder is blocked on C9/C14 being fixed first.
2. Provider/auth failure (`stop_reason==='error'`) → dead-key reroute via fresh recommend with `excluded_models` = the dead provider's models (C3), cleared at `endSession`.
3. Budget-abort of a rung (ladder consults the ledger before every rung).
4. Pre-emptive amber signals, read **programmatically from `routing.warnings`** (never the rendered set — `collapse_guard_applied` is display-hidden, C18): `collapse_guard_applied` (the guard *explicitly relies* on the escalation loop, `engine.py:930` — force-judge these turns regardless of cadence), `no_model_meets_threshold`, `success_interval_width == 1.0`, or `decision_basis === 'prior'` (C20: prior alone, or `confidence < ε` — the old "prior AND confidence 0.5" condition is unreachable).

**Rung mechanics — fresh recommend per rung.** One decision-log row holds ONE reconciliation, so:
1. Judge fails rung *k* → POST feedback on rung *k*'s `rec_id` with **consistency-clamp-aware labels (C21)**: outcome via `gradeOutcome` semantics (quality ≥ 0.4 → `partial`, < 0.4 → `failure`), `quality_score = judgeScore`, realized cost, `notes:"rung=k"`. The *escalation decision* (score < ladder threshold, e.g. 0.8) is independent of the outcome label — never post `failure` with quality 0.7 (server clamps to 0.6 + flags `quality_outcome_mismatch`). This feedback *is* the learning signal.
2. Snapshot/rollback messages (`messages.length` + `turnsTaken`).
3. Fresh `recommend()` with `excluded_models = [failed rungs]`, same task/difficulty/tags, updated `max_cost_per_call` from the ledger → new `rec_id`, valid propensities, its own decision row. (Alternative for a single silent downgrade: reuse the rec_id and report divergence via `chosen_model_id` — the fresh-recommend path keeps per-rung attribution clean and is the default.)
4. **Cost honesty (C13):** rung *k+1*'s reserve must clear *before* message truncation; discarded-rung spend stays **spent** in the ledger (never released); add the cold cache-write cost of the accumulated prefix to every rung on a model ≠ current — when the prefix is large, the shepherding rung usually wins the arithmetic.
5. Winning rung → success feedback on its own `rec_id`, `verified_in_production` from tests-passed (never hardcoded — C14), `iterations = turnsTaken`.

**Server escalation interplay:** expose `allow_llm_escalation` client-side (cost-control opt-out — the server may spend org money on reasoner consults today with no client toggle **and no org ceiling**; the server-side per-org daily reasoner cap is §4.11). Do not duplicate the reasoner client-side.

### 4.7 Closing the bandit loop (off-policy learning) — the client's exact obligations

The server logs, per decision: full candidate snapshots with **true selection propensities** (Thompson MC frequencies / softmax / degenerate argmin, `engine.py:255-256`), exploration flags, `shadow_chosen_model_id`, `raw_predicted_success_chosen` (the DR direct-model term, stored pre-calibration), and counterfactual costs. Exploration is a per-org server-side opt-in the client cannot toggle per call. Therefore:

- **The client never logs propensities and never explores.** Client re-ranking or ε-greedy corrupts IPW and every future IPS/SNIPS/DR estimate. The client's entire learning contribution is **feedback quality** — and today that contribution is negative (C14).
- **Stop the poisoning first (P2-1a, hotfix-sized):** (a) stop hardcoding `verified_in_production: true` — send it only when tests actually passed (immediately kills spurious lesson promotion, which requires verified=true, `feedback.py:163`); (b) unjudged turns must stop feeding fabricated 0.9 successes into `weighted_success` — target state is **telemetry-only feedback**: cost/latency/tokens with no quality-bearing outcome, which requires a small server change (accept outcome-less cost telemetry, or a `judged: bool` field that suppresses `_OUTCOME_DEFAULT_QUALITY` substitution at `records.py:16`); interim client-only mitigation is `verified_in_production:false` + `notes:"unjudged"` so poisoned rows are at least identifiable and lessons stop promoting.
- **Fields the client must send correctly** (most already sent, per C14/C17): `quality_score` from a real judge; `outcome` via `gradeOutcome`; `actual_cost_usd` as the **run-total** running sum, not last-turn; `latency_ms` with documented semantics; `iterations`; `verified_in_production` = tests-passed; `chosen_model_id` (may diverge); `notes` (rung index, abort reason, judged marker). `idempotency_key` is optional — the server defaults `outcome_idempotency_key(rec_id, chosen_model_id)` (`feedback.py:102-104`).
- **Consume `FeedbackResponse`** (`reinforced_entry_ids`, `updated_confidence`, `reflection_triggered`, `lesson_promoted`) into the local DB — these are the Mubit provenance ids Pillar 4 joins on, currently discarded on every call (router.ts:187-198 returns void).
- **Offline buffering is legitimate:** feedback up to 90 days late still teaches via the decision-log context path (attribution/lesson-promotion skipped, learning kept).
- **OPE hazard flag:** weight by the decision log's per-candidate `propensity`, **never** by `PropensityTracker` shares (`propensity.py` is a Laplace-smoothed evidence-debiasing input, not IPS weights). Use DR with `raw_predicted_success` as the direct model + clipped weights (Double Clipping, arXiv 2309.01120) — plain IPS on rare premium picks has unusable variance at our traffic. And mark an **epoch boundary** at P2-1: quality data before it is 0.9-fabricated; exclude pre-epoch rows from published quality/savings claims.

### 4.8 Two-sided decision record, one join key

| Fact | Source of truth | Why |
|---|---|---|
| Candidate set, propensities, τ, policy, shadow pick, counterfactual baselines, calibration/savings/health metrics | **Server decision log** (Postgres, 90-day) + `GET /v1/savings`, `/v1/calibration` | Already persisted and computed; server-private (propensities cannot exist client-side) |
| Session/run/turn linkage, judge per-dimension detail, tool traces, rung history, budget events, offline/pinned locally-routed decisions, >90-day retention | **Client SQLite** (`routing_decisions` + `budget_events`) | Server row has no `session_id`/`run_id`; `quality_score` is one scalar; offline decisions exist nowhere else |
| `ranked[]` snapshot | Server canonical; client keeps a **cached copy** on the row | For offline OCR/regret math and the provenance bundle — labeled cache, not truth |

**Sync direction:** client → server exclusively via `/v1/feedback` keyed on `rec_id` (idempotent; the existing `synced=0` flush). Server → client is **read-only pull** of fleet metrics for display. A server-side **advisory org spend ledger** (one aggregation over reconciled `actual_cost_usd` in the decision log, exposed via `/v1/savings`) makes client-ledger vs server-ledger divergence itself an anomaly signal. Workflow-level joins remain client-owned: `workflow_recommendation_id` is a throwaway uuid persisted nowhere server-side; only per-step `recommendation_id`s are durable join keys.

**Data governance (new payloads cross into sensitive territory):** stamping repo names as `tags` and full `task` strings into a 90-day org-scoped Postgres log needs `DELETE /v1/decisions?before=` (org-scoped), per-org retention override (constructor default today, `decisionlog.py:175`) via org config, and a one-line data-handling doc.

**P0b re-scope (C10):** the DecisionRecord writer is no longer "the only decision record" — it is the session-scoped half of the join, plus the ledger audit, plus offline decisions. Fleet savings/calibration flow from the server on day 0.

### 4.9 Concrete interface diffs

**TypeScript (packages/tui/src):**

```ts
// minima/router.ts — RecommendOpts (extends today's {taskType, slider, tags})
interface RecommendOpts {
  taskType?: string;
  difficulty?: "trivial"|"easy"|"medium"|"hard"|"expert"; // [API CHANGE] thread promptRouted→route→recommend
  slider?: number;
  tags?: string[];
  expectedInputTokens?: number;      // computed from state.messages in route()
  maxCostPerCall?: number;           // ledger-derived, per call
  minQuality?: number;               // τ floor; survives slider clamps
  excludedModels?: string[];         // dead-key + failed-rung exclusion (NO excludedProviders — C3)
  maxCandidates?: number;            // min(pool.length, 16) when pool > 8 — also add the field to client.ts recommend() (C18)
  allowLlmEscalation?: boolean;      // cost-control opt-out
  explain?: boolean;
}

// minima/router.ts — RoutingResult additions: ONLY the four fields the mapper actually drops (C18)
interface RoutingResult /* + */ {
  recommendedActions: string[];      // enable_prompt_cache | set_effort:<level>
  selectionPolicy: string;           // argmin | epsilon_softmax | thompson
  classifiedTaskType: string;
  classifiedDifficulty: string;      // → per-prompt effort (§4.5 Phase A)
  effort?: ThinkingLevel;            // Phase B/C of §4.5
}
// warnings/thresholdUsed/confidence/fallbackModelId/ranked/estCostLow/High/costBandBasis are ALREADY mapped
// (router.ts:36-52). Consumers must read routing.warnings, not the rendered set (collapse_guard_applied is display-hidden).

// minima/router.ts — feedback stops discarding the response and stops fabricating verification (C14)
feedback(args: FeedbackArgs & { notes?: string;
  verifiedInProduction: boolean /* = tests passed, NEVER hardcoded */ }): Promise<FeedbackResponse>;
// actual_cost_usd = ledger running sum for the run (C17), not lastAssistant().usage.

// minima/client.ts — every request carries the client version for server-side compat gating (§4.11)
headers["X-Minima-Client"] = VERSION;

// agent seams
setShouldStopAfterTurn(fn | null)    // [API CHANGE] — unchanged from prior corrections
// ai/providers: anthropic → thinking:{type:'adaptive'} + output_config.effort (NEVER budget_tokens on ≥4.6);
// openai_compat → reasoning_effort; google → thinkingConfig budget. MUST land before --thinking is honored (§4.5 gate).
```

**Python (src/minima) — ordered by leverage:**

```python
# 0. PREREQ for any schema change: migration tooling. decisionlog creates schema via inline
#    CREATE TABLE IF NOT EXISTS (decisionlog.py:255,393) which never ADDS columns — alembic (or a
#    schema_version table + ordered idempotent DDL behind an advisory lock), additive-only nullable-
#    default policy, migration step in prod.yml BEFORE traffic shift.
# 1. Capability echo (the budget gate is unsound without it): GET /v1/capabilities
#    {server_version, features[]} (version.py exists; /v1/health already serves it) and/or
#    RecommendResponse.honored_constraints: list[str]. Pydantic extra="ignore" silently drops
#    unknown constraint fields from old servers — the client must be able to tell.
# 2. Feedback integrity (client-trusted threat model): reject/flag actual_cost_usd outside
#    k × [est_cost_low, est_cost_high] of the referenced rec_id (band is on the decision row);
#    per-key token-bucket rate limits on /v1/recommend + /v1/feedback (none exist today);
#    divergent chosen_model_id must be a catalog member; CUSUM on per-key feedback distributions
#    (poisoning detector); advisory per-org spend aggregate exposed via /v1/savings.
# 3. Telemetry-only feedback (kills the 0.9 fabrication, C14): judged: bool | None on
#    FeedbackRequest — unjudged success feeds cost/latency aggregates but NOT weighted_success
#    (suppress _OUTCOME_DEFAULT_QUALITY substitution at records.py:16) and never promotes lessons.
# 4. Zero-schema-change effort interim: engine._actions_for() emits "set_effort:<level>".
# 5. schemas/recommend.py: RankedModel.effort (Phase C: catalog variants model@effort; posteriors/
#    Thompson/calibration/decisionlog apply unchanged per arm). Version-gate: serve plain model ids
#    to clients below the X-Minima-Client floor.
# 6. Org config: GET/PUT /v1/org/config keyed on TenantContext.org_id — {budget tiers, min_quality
#    floor, allow_llm_escalation default, exploration opt-in, retention override}; client merges
#    tighten-only over local config. Generalizes the existing per-org CSV pattern
#    (minima_epsilon_selection_orgs, config.py:198,205). Plus a per-org daily reasoner budget
#    (Redis, already in-stack) refusing consults past the cap with a warning string.
# 7. api/routers/recommend.py (workflow): total_est_cost_high = Σ (est_cost_high ?? est_cost_usd).
# 8. schemas/workflow.py: WorkflowRequest.budget_usd + greedy/ILP allocator (BAMAS-style knapsack;
#    per-step allocation ∝ posterior_interval_width; Plan-and-Budget) writing per-step
#    max_cost_per_call. NOTE (C15): merged_over is OVERRIDE-WINS — a step CAN relax a global cap.
#    Either the allocator is the sole writer of step caps, or add min() semantics for cap-type fields.
# 9. Data governance: DELETE /v1/decisions?before= (org-scoped); per-org retention via org config.
# 10. Cleanups & later: fix Constraints.max_cost_per_call docstring ("hard filter" → soft+warning);
#     Constraints.excluded_providers sugar (expand to excluded_models server-side); score.py
#     effective-price modifiers (switching-cost term for candidates ≠ current model; 0.5× batch lane
#     for latency-insensitive tags: judge calls, seeding, retro-evals); wider reserve quantile;
#     minima-calibration-report Postgres support (report.py:68-72 constructs SqliteDecisionLog directly).
```

### 4.10 Pillar-2 roadmap slice (replaces P2a/P2b; feeds P3a/P3b)

| Step | Content | Size | Gate |
|---|---|---|---|
| **P2-0 Lever plumbing + cost-truth fix** | RecommendOpts extension; `expectedInputTokens` from live context; `max_candidates` (client.ts + router.ts); map the 4 dropped fields (`recommendedActions`/`selectionPolicy`/`classifiedTaskType`/`classifiedDifficulty`); programmatic `warnings` consumption; **feedback `actual_cost_usd` = run-total running sum (C17)**; `catalog_version` check/refetch; non-Anthropic cache handling + honor `recommended_actions`; `X-Minima-Client` header; `/slider` command | ~3–4 d | Server-observed est_cost basis flips off 'estimate' after 3 obs; multi-turn run's reported cost equals meter total; realized cost within band on cache-supporting models (already expected on Anthropic — C19) |
| **P2-1 Judge activation + poison stop** | **P2-1a hotfix (can ship alone): stop hardcoding `verified_in_production:true`; tag unjudged feedback** (C14). Then: `LLMJudge` wired in cli/main.ts:315 (through the ledger, batch-priced, staged default-off with first-run notice — it starts spending real money where ConstJudge spent zero); `verified_in_production` = tests-passed; `gradeOutcome` labeling (C21); telemetry-only unjudged feedback once the server accepts it; persist FeedbackResponse; mark the data-epoch boundary | ~3 d | Zero lessons promoted from unjudged turns; quality non-null on judged turns; gate on a real **judged discriminator** (notes-tag or `judged` field) — NOT "feedback_coverage > 0", which is already true today and vacuous |
| **P2-2 BudgetLedger** | Scopes; reserve (C16 formula) / running-sum reconcile; `setShouldStopAfterTurn` [API CHANGE]; per-call `max_cost_per_call`; **capability-gated** infeasibility enforcement (degrade to client pre-check on old servers); graduated tiers incl. wrap-up turn; prompt-signal reminder (+`task_budget` mirror); ProgressMonitor; hard invariant caps behind `config_version` migration + `minima doctor`; shared-file single-writer ledger (`BEGIN IMMEDIATE`) + N-session scope arithmetic; `budget_events` table; no-bypass lint; degraded-mode table; shadow→warn→enforce | ~1.5–2 wk | Tight-cap E2E: warns 75/90, wrap-up answer at 100 %, then abort; no bypassed call sites (lint green); infeasible-budget prompt refuses in enforce mode *only* with capability confirmation; two concurrent sessions never jointly overshoot |
| **P2-3 Recovery ladder** | Triggers (judge/auth/budget/amber — amber = `prior` alone or `confidence < ε`, C20; read `routing.warnings` programmatically, C18); fresh-recommend-per-rung with `excluded_models`; per-rung feedback with `gradeOutcome` labels (C21); rung reserve-before-truncate; switching-cost check + shepherding rung; force-judge on `collapse_guard_applied`; **max 3 rungs/turn** | ~1 wk | Cheap-model failure recovers on fallback rung once, never on null judge; zero `quality_outcome_mismatch` flags server-side; both rungs' rec_ids reconciled; dead-key reroute never retries the dead provider |
| **P2-4 Effort routing (Phase A)** | **Gate-ordered:** provider effort mapping (no `budget_tokens` on ≥4.6) merges FIRST; only then honor `--thinking` and map `classifiedDifficulty`→effort per prompt (staged default-off); optional DART probe on `decision_basis='prior'` (ledger-priced, inside the rung cap) | ~4 d | Anthropic calls carry `output_config.effort`, zero 400s; no code path can set thinking≠off before the mapping lands; effort varies per prompt with difficulty |
| **P2-5 Fleet metrics view** | `/cost --fleet` + savings footer from `GET /v1/savings` (dual-baseline vocabulary: vs_premium generous / vs_declared honest — always send `baseline_model_id`) and `/v1/calibration` | ~2 d | Footer shows server-truth savings; survives process restart |
| **P2-6 Server track** (parallel, gates Phase B/C) | §4.9 Python list in order: migrations → capability echo → feedback integrity/rate limits → telemetry-only feedback → org config + reasoner cap → `set_effort` action → effort arms (shadow-first, 2 tiers, shrinkage priors, version-gated) → workflow band totals + budget allocator (C15-aware) → governance endpoints | Phase 3 | Canary + replay gates in §4.11 |

Dependencies unchanged: subtask/parallel scopes still gate on Pillar-1 spawn; the spent-fraction slider rule (`min_quality`-paired) remains the single-agent stopgap until the workflow allocator exists. P2-1a is independent of everything and ships first.

### 4.11 Shipping prerequisites: rollout, compatibility, eval (server-side track)

1. **DB migrations (blocks all Phase B/C schema work):** no alembic, no `migrations/` dir exists; the decision log self-creates via `CREATE TABLE IF NOT EXISTS` (`decisionlog.py:255,393`), which never adds columns. Adopt alembic or a minimal `schema_version` + ordered idempotent DDL at startup behind an advisory lock; additive-only nullable-default column policy; migration step in `prod.yml` before traffic shift.
2. **Canary deploys for routing-behavior changes:** `prod.yml` is tag→build→Cloud Run at 100 % traffic. Use `--tag canary --no-traffic` → 10 %→100 %, gated on `/v1/calibration` routing-health deltas (top_model_share, cost_position, ECE) over a soak window; per-org feature flags for Phase B/C by generalizing the existing `minima_*_selection_orgs` CSV pattern into org config.
3. **Contract compatibility:** capability echo (`GET /v1/capabilities` and/or `honored_constraints[]`) because `extra="ignore"` silently drops new constraint fields on old servers; `X-Minima-Client` header for version-gating arm-variant responses; a deprecation/support-window policy; CI contract-test matrix (current server × N-2 client fixtures, current client × N-1 server).
4. **Eval/regression gates:** (a) fix `minima-calibration-report`'s Postgres path (`report.py:68-72` is Sqlite-only — it gates everything downstream); (b) **golden-replay suite**: nightly export of N decision rows (contexts + candidate snapshots), re-run the candidate engine, assert decision-agreement/τ/cost-position within tolerance — required by the deploy pipeline; (c) **OPE-as-deploy-gate**: the DR estimator run on the new policy vs logged propensities *before* rollout; (d) effort arms launch shadow-only for weeks; (e) client side: deterministic fake-provider harness (extend `tests/harness` — `test_agent_loop.py`/`test_auth_reroute.py` are the seams) covering ladder triggers, estimate-basis reserve math, wrap-up-turn at 100 %, and the no-bypass lint.
5. **Org config & governance:** `GET/PUT /v1/org/config` (budget tiers, `min_quality` floor, `allow_llm_escalation`, exploration opt-in, retention) with tighten-only client merge; per-org daily reasoner budget; `DELETE /v1/decisions?before=`; feedback plausibility clamps + per-key rate limits + advisory org spend ledger + CUSUM poisoning detection (§4.4 threat model).
6. **Upgrade staging for existing users:** shadow→warn→enforce is the discipline for **all three** spend-changing features (budget, judge, auto-effort), not budget alone; `config_version` migration; first-run notice; `minima doctor`; cluster-key continuity fallback for one release after tags/task_type stamping lands.

---

### Pillar deltas from the routing re-grounding (2026-07-02)

- **Section 3 (Pillar 1):** Stamp `difficulty`/`task_type`/`tags` per `Delegation` node — the server treats them as authoritative overrides and difficulty scales the cost estimate (`classify.py:131-134`; `engine.py:170-172`); promoted from nice-to-have to the cheapest routing-quality lever the orchestrator owns. `recommendWorkflow` is a **DAG pricer, not a DAG engine**: `depends_on` is schema-only dead code, steps run sequentially, `workflow_recommendation_id` is minted and never persisted (`api/routers/recommend.py:38-61`) — use it to price plans in one round trip; execution stays local. Fan-out gating hardens to **deny-by-default** (Anthropic's ~15× multi-agent token tax; phase-transition analysis arXiv 2601.17311 shows single agents dominate at higher budgets) unless the ledger's N-child reserve clears AND the task is decomposable/high-value. Warm-start caveat: routerbench seeding covers zero tool_use/agentic tasks with difficulty hardcoded "medium" (`routerbench.py:23-37,105`) — per-node feedback (`iterations`, `verified_in_production`) is the real learning path, which raises P2-1's priority above everything in Phase 3.
- **Section 5 (Pillar 3):** **P0b re-scoped, R1 softened** — the server already persists every decision (Postgres, 90-day, `decisionlog.py`) and serves savings/calibration today; the client DB is the *session-scoped half joined on `rec_id`* (linkage, judge detail, offline/pinned rows, budget audit, >90-day retention). P0b's gate language changes from "nothing downstream computes without it" to "no provenance/resume/local-analytics without it"; fleet metrics flow from the server on day 0. Add the **`budget_events` table** (reserve/reconcile/deny/approve/override, keyed scope + `rec_id`) and columns on `routing_decisions` for `selection_policy`, `classified_*`, `effort`, rung index, and FeedbackResponse ids; add the shared per-user **ledger DB** (single writer, `BEGIN IMMEDIATE`). **P4 sync re-planned:** libSQL embedded replicas are the vendor's legacy path (Turso pivoted to the Rust rewrite, edge replicas discontinued, users pushed to beta CDC Turso Sync) — default to first-party HTTPS sync of `synced=0` rows to api.minima.sh on the `rec_id` key. **sqlite-vec demoted:** effectively unmaintained since mid-2025 (issue #226) — mark the `vec0` DDL provisional; plan-B is BLOB embeddings + JS cosine at lessons-table scale. Packaging correction: bun `--compile` CAN embed napi `.node` addons (Bun 1.3); only dlopen'd loadable extensions can't ship in-binary — don't lump Turso (napi) with sqlite-vec (loadExtension).
- **Section 6 (Pillar 4):** `workflow_recommendation_id` is **not a join key** (persisted nowhere server-side) — workflow-level provenance needs a client-owned key; only per-step `rec_id`s join. Persist `FeedbackResponse.reinforced_entry_ids`/`lesson_promoted` per decision — the Mubit-side provenance ids the Work Record wants, currently discarded (router.ts returns void). The org-scoped server decision row becomes citable **corroborating evidence** in the bundle. Emit a **Cursor Agent Trace** (v0.1.0 RFC) sidecar for file/line attribution interop — its explicit exclusion of cost/routing/signing confirms the signed MWR predicate stays uniquely ours. Pin `taskState` to **A2A v1.0 stable**; promote **ACP session/load** to an explicit roadmap item sharing `rehydrateRun()`. Sharpen the `judged: n/m` honesty note: today it is 0/m by construction (ConstJudge), and pre-P2-1 server-side quality history is 0.9-fabricated.
- **Section 7 (Metrics):** **Consume, don't rebuild** — ECE, CUSUM drift, feedback_coverage, top/cheapest_model_share, cost_position, shadow_agreement exist at `GET /v1/calibration`; dual-baseline savings at `GET /v1/savings`. Client metric functions shrink to what the server can't see: session-scoped QpD, offline/pinned spend, budget-event analytics. Adopt the server's savings vocabulary — `vs_premium` (generous) vs `vs_declared` (honest; always send `baseline_model_id`); never present `total_est_cost_if_all_premium` as savings (max-of-ranked per step, shifts with caller constraints). **Regret-vs-oracle shrinks to an offline estimator over existing server rows** (IPS/SNIPS/DR with clipping; the full OPE substrate — true propensities, exploration flags, shadow picks, `raw_predicted_success` — is already logged); hazard: weight by decision-log `propensity`, never `PropensityTracker` shares. Report at equal token budget or the claim is confounded. Mark the **P2-1 data-epoch boundary**: exclude fabricated-0.9 quality rows from published numbers. External anchors: TwinRouterBench SWE-bench-Verified dynamic track; RouterArena submission. Ops gap: `minima-calibration-report` cannot read prod Postgres (`report.py:68-72`) — fix gates the replay/OPE work.
- **Section 8 (Boundary contract):** Answer to §12 Q1: **`/v1/plan` is confirmed net-new** — nothing decomposes server-side; the engine is stateless-per-request. Update the table: "Cascade retry (local)" → "**Recovery ladder (local)** walking **server-supplied rungs** (`fallback_model`, `ranked[]`) — never re-ranked"; "Budget ledger (local)" gains "per-call cap server-honored as soft filter + `no_model_within_cost_budget` warning; enforcement requires capability confirmation". Add rows: **capability handshake** (`GET /v1/capabilities` / `honored_constraints[]`, hosted); **org policy config + per-org reasoner cap** (hosted); **advisory org spend ledger** (hosted, anomaly signal); **server escalation = reasoner consult** (hosted, client `allow_llm_escalation` opt-out). The hosted side is no longer "stateless meta-decisions" only — it is also the durable decision log + fleet metrics store.
- **Section 9 (Data model):** `rec_id` confirmed as the two-sided join key — the server row (propensities, τ, policy, counterfactuals) and client row (run/session linkage, judge detail, budget events) are halves of one record. `workflow_recommendation_id` explicitly excluded from the join-key list. Feedback idempotency is server-defaulted (`outcome_idempotency_key(rec_id, chosen_model_id)`, `feedback.py:102-104`) — the `synced=0` flush is retry-safe without client keys. Offline/pinned rows gain an explicit `routed=offline` label; add FeedbackResponse provenance ids (`reinforced_entry_ids`, `lesson_promoted`) as columns on `routing_decisions`.
- **Section 10 (Roadmap):** **P2a/P2b are replaced by the P2-0…P2-6 slice** (§4.10). Insert **P2-1a (poison stop: un-hardcode `verified_in_production`, tag unjudged feedback)** as a hotfix that can ship immediately — it repairs live data corruption and is independent of every phase gate. Old **P3a cascade** folds into **P2-3 recovery ladder** (rungs are server-supplied; blocked on P2-1 judge, not on Phase 3); **P3b auto-tune** stays but is `min_quality`-paired. Fleet savings reporting (P2-5) is **day-0 capable** — no longer blocked on P0b maturity. Add a **parallel server track** (P2-6/§4.11): migrations → capability echo → feedback integrity/rate limits → org config → effort arms (shadow-first), with canary deploys and the golden-replay + OPE gates as pipeline requirements. R1's wording softens per the Section 5 delta; R6's `excludedProviders` mechanism corrects to `excluded_models` (no such server field). MVP line unchanged in spirit, but "enforced budget" now reads "capability-confirmed enforcement, else client-side pre-check".

---

## 5. Pillar 3 — Database / persistence (the load-bearing prerequisite)

**Grounded seams (verified).** `store.append()` has **zero callers** — the write path is dead. During an interactive run **no `SessionStore` is bound to the agent** (constructed transiently only in `/resume`/`/list`); `promptRouted` writes to React state + `agent.agentState.messages`, never disk. `/new,/name,/fork,/clone,/tree` are cosmetic; `loadSession` restores only `payload.text` and drops cost/model/routing/goal. `CostRow` (`meter.ts:11`) is in-memory only and carries **no `recommendationId`**. `RoutingResult` (`router.ts:36-52`) carries `recommendationId/chosenModelId/decisionBasis/ranked[]/estCost{,Low,High}/baselineCostUsd/confidence/thresholdUsed`. `promptRouted` (`runtime.ts:110-170`) is the single choke point where task + routing + `last` (usage) + `latencyMs` + `turnsTaken` + judge `{quality,outcome}` are all in scope, next to the existing `meter.record`. `bun >= 1.2` required; `bun:sqlite` is built-in.

### Corrections folded in

- **P0 is NOT "land one routing entry."** It is: build the full session **write path** AND bind a persistent store (here, `MinimaDb`) to the interactive agent. Do it as (a) a **second `Agent.subscribe()` DB sink**, (b) a **DecisionRecord writer at `promptRouted`**, (c) a **flush at `endSession()`**.
- **DbSink tool correlation:** `tool_execution_end` carries only `{toolCallId, result, isError}` — no name/args. Maintain a per-run `Map<toolCallId,{name,args}>` populated on `tool_execution_start` (`loop.ts:231` emits `tc.name` + parsed args), consumed on `_end`. Do not write placeholder tool names.
- **`AssistantMessage.model` is a plain string** — use `m.model` directly, not `m.model?.id`.
- **Decouple `run_id` from provider `session_id`.** `agent.sessionId` is the provider prompt-cache key (`loop.ts:200`); keep it as a **column** on `runs`, use a DB-owned `run_id = newId()` as PK/FK. `/fork`/`/resume` mint a new `run_id`.
- **fork/clone across `run_id`** must copy events with **fresh event ids + remapped `parent_id`**, and mint **new `rec_id`s** for any copied routing rows (`rec_id` is PK and the hosted join key — never duplicate). Set `forked_from_event_id` to the **original** event id.
- **Rename the mislabeled view.** `actual - est_cost_low` is **estimate error**, not oracle regret. True regret needs the persisted `ranked[]` joined against realized quality thresholds — defer that to the metrics read-model.
- **Multi-writer:** WAL = concurrent readers + **one** writer. Parallel sub-agents ⇒ set `PRAGMA busy_timeout`, wrap each turn's inserts in **one transaction**, and either write per-child branch rows or funnel through a single serialized writer.
- **Source-of-truth vs fail-open tension:** each turn's inserts are one transaction that commits atomically or flags the run `degraded=1`; fail-open at the **run** boundary (never kill the turn) but never leave silent gaps that cost views read as truth.
- **P3 (sqlite-vec) + P4 (Turso) are native-loadable-extension work.** `bun build --compile` deliberately avoids native deps (keytar note in `build.ts`). `db.loadExtension()` needs a per-platform `.dylib/.so` present at runtime — **not** inside the compiled binary. Gate semantic recall behind a runtime capability check (`try loadExtension else fall back to Mubit network recall`) and treat it as per-platform vendoring, **not** "zero-dependency."

### Core DDL (schema v1)

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (1);

CREATE TABLE projects ( project_key TEXT PRIMARY KEY, namespace TEXT, created REAL NOT NULL );

CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,                 -- DB-owned; NOT the provider session_id
  project_key   TEXT NOT NULL REFERENCES projects(project_key),
  provider_session_id TEXT,                        -- agent.sessionId (prompt-cache key)
  display_name  TEXT,                              -- backs /name across reload
  parent_run_id TEXT REFERENCES runs(run_id),
  forked_from_event_id TEXT,
  git_base_sha  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',    -- active|done|aborted|degraded
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE INDEX ix_runs_project ON runs(project_key, updated DESC);

CREATE TABLE events (                              -- append-only SOURCE OF TRUTH
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  parent_id TEXT REFERENCES events(id),
  agent_id  TEXT,                                  -- NULL = lead; set for sub-agents (childId)
  type TEXT NOT NULL,                              -- user|assistant|tool|system|routing
  span_kind TEXT, ts REAL NOT NULL,
  payload TEXT NOT NULL                            -- JSON only (never pickle/msgpack)
);
CREATE INDEX ix_events_run ON events(run_id, ts);

CREATE TABLE routing_decisions (                   -- one row per turn = replay buffer + regret substrate
  rec_id TEXT PRIMARY KEY,                          -- recommendationId: JOIN KEY (local↔feedback↔Mubit)
  run_id TEXT NOT NULL REFERENCES runs(run_id), event_id TEXT REFERENCES events(id),
  agent_id TEXT, parent_rec_id TEXT,                -- sub-agent tree
  task_label TEXT, task_type TEXT, difficulty TEXT,
  chosen_model TEXT, decision_basis TEXT, confidence REAL, threshold_used REAL, -- τ for oracle math
  ranked TEXT,                                     -- JSON Ranking[] (full ladder w/ est_cost, predicted_success, interval_width, evidence_count)
  est_cost_usd REAL, est_cost_low REAL, est_cost_high REAL,
  all_premium_cost_usd REAL,                        -- max over ranked[].est_cost (TRUE all-premium anchor)
  configured_baseline_cost_usd REAL,               -- baselineModelId candidate (null unless set)
  actual_cost_usd REAL,
  quality REAL, judged INTEGER NOT NULL DEFAULT 0, -- judged=0 ⇒ cadence-skip; quality NULL ⇒ abstain
  outcome TEXT,                                    -- success|partial|failure|abstain|aborted
  turns INTEGER, latency_ms INTEGER, ts REAL NOT NULL, schema_v INTEGER NOT NULL DEFAULT 1,
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), event_id TEXT REFERENCES events(id),
  tool_name TEXT NOT NULL, args TEXT, result TEXT, is_error INTEGER NOT NULL DEFAULT 0, ts REAL NOT NULL
);

-- P3 (capability-gated): sqlite-vec + bi-temporal lessons
CREATE TABLE lessons (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key),
  content TEXT NOT NULL, source_run_id TEXT, source_event_id TEXT,
  valid_from REAL NOT NULL, valid_to REAL, created REAL NOT NULL   -- contradiction closes valid_to
);
CREATE VIRTUAL TABLE lesson_vec USING vec0(embedding float[384]);
CREATE TABLE lesson_vec_map (vec_rowid INTEGER PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id));
```

**DecisionRecord writer** (in `promptRouted`, after `feedbackSafely`, idempotent on `rec_id`):
```ts
if (this.db && routing?.recommendationId) {
  this.db.writeDecision({
    recId: routing.recommendationId, runId: this.runId, agentId: this.childId ?? null,
    taskLabel: shortLabel(content), chosenModel: routing.chosenModelId,
    decisionBasis: routing.decisionBasis, confidence: routing.confidence,
    thresholdUsed: routing.thresholdUsed, ranked: routing.ranked,          // JSON.stringify
    estCostUsd: routing.estCostUsd, estCostLow: routing.estCostLow, estCostHigh: routing.estCostHigh,
    allPremiumCostUsd: Math.max(...routing.ranked.map(r => r.estCostUsd)), // corrected anchor
    configuredBaselineCostUsd: routing.baselineCostUsd,                    // null unless baselineModelId set
    actualCostUsd: runningSumUsd,          // corrected: SUM over turns, not last
    quality, judged: judgedThisTurn ? 1 : 0,
    outcome: failed ? "failure" : outcome, turns: turnsTaken, latencyMs,
  });
}
```

---

## 6. Pillar 4 — Portable e2e work provenance (Minima Work Record)

**Grounded seams (verified).** `SessionEntry` persists `{id,parentId,type,ts,payload,label}` but routing/cost provenance is never written; there is **no `routing` EntryType**. `SessionSummary.displayName` is hardcoded null. `pathTo`/`forkTo`/`cloneTo`/`parentId` tree exists but operates on a store that is never populated. `RoutingResult` + `CostRow` + judge output hold every field the predicate needs.

### Corrections folded in

- **MWR is a projection over the WS3 record — so it inherits WS3's real P0** (build the write path + bind the store). Not a one-liner.
- **`latencyMs` and `budgetRemainingUsd` in the routing payload are not persisted state** — `latencyMs` is a discarded local; there is no budget object. Surface `latencyMs` explicitly if wanted; mark `budgetRemainingUsd` optional/nullable.
- **`judgeQuality` is null for essentially all CLI runs** — `cli/main.ts` wires `ConstJudge(null)` and the default judge runs on a cadence. Surface **`judged: n of m turns`** in the predicate so a null-heavy record is honestly interpretable. Do not let the "reasoning provenance" pitch imply dense quality data by default.
- **`goal` EntryType is dead** — source the continuation brief's progress/decisions from actual `/goals` state + routing entries; stop claiming `goal` entries in the bundle until they're written.
- **Resume is net-new** — define a `rehydrateRun()` that (a) replays messages, (b) rebuilds `CostMeter.rows` from routing rows, (c) restores `promptsRun`/namespace/memory session, (d) sets `gitBaseSha`. Default to **pure reconstruction** (no tool re-exec). Precheck HEAD/tree vs bundle `gitBaseSha`; warn loudly on divergence.
- **Verify = two independent checks.** (A) **Bundle integrity:** DSSE sig over PAE + every manifest artifact digest matches on disk (offline, cross-machine, no repo). (B) **Working-tree reconciliation:** git subjects match the tree — **advisory** unless `--strict`. Resume requires only (A) and applies `changes.diff` via `git apply --3way`. Never mutate the user's index: snapshot the tree via a temp `GIT_INDEX_FILE` for `write-tree`; define `changes.diff` deterministically as `git diff <gitBaseSha> -- .`.
- **Redaction pass before signing** — scan `session.jsonl`, `changes.diff`, brief for secret/`.env` patterns; replace with `<redacted:reason>`; record `redactionCount`. `--no-redact` opt-out.
- **Trust claim honesty** — bundled-pubkey DSSE proves **integrity + "signed by this bundle's key," not identity**. Maintain a TOFU keyring (`~/.minima-harness/keys/known_signers.json`) and WARN on unknown keyid. Keyless (Sigstore/Mubit OIDC→Fulcio) is the recommended cross-org mode but is **out of shipping scope** until confirmed.
- **in-toto conformance** — standard digest keys (`sha256`/`sha1`; `gitCommit` acceptable per ITE-6, `gitTree` under a documented custom key), standard base64, exact `payloadType application/vnd.in-toto+json`. Add a conformance test against `cosign verify-attestation`; drop the "cosign-compatible" claim if it fails.
- **Bundle location/size** — write to `~/.minima-harness/work/<id>/` by default (in-repo `.minima/work` opt-in, auto-`.gitignore`d so it never pollutes the next diff). Cap artifact bytes; reference oversize `session.jsonl`/`changes.diff` by digest.
- **Rename** the continuation brief to `CONTINUATION.md`/`HANDOFF.md` (avoid clobbering a repo's real `AGENTS.md`).
- **Sub-agent provenance** — add `agentId`/`parentAgentId` to the routing payload now; the projection reconstructs a `routingDecisions` **tree**. Scope P1–P3 to single-agent; multi-agent export follows Pillar 1 isolation.

### Predicate shape (corrected)

```jsonc
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "git+HEAD", "digest": { "gitCommit": "<sha>", "sha1": "<tree-sha>" } },
    { "name": "changes.diff", "digest": { "sha256": "<hex>" } }
  ],
  "predicateType": "https://minima.sh/workrecord/v1",
  "predicate": {
    "workDefinition": {
      "task": "<goal summary>", "budgetUsd": 5.0,          // nullable
      "candidatePool": ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-flash"],
      "continuationDigest": { "sha256": "<hex-of-CONTINUATION.md>" },
      "externalParameters": { "costQualityTradeoff": 0.5, "namespace": "<project_key>",
                              "baselineModelId": null },   // savingsPct=null when unset
      "internalParameters": { "judgeEvery": 1, "maxTurns": 40 }
    },
    "runDetails": {
      "builder": { "id": "https://minima.sh/harness", "version": "0.5.1", "minimaUrl": "https://api.minima.sh" },
      "metadata": { "invocationId": "<run_id>", "projectKey": "<repoIdentity>",
                    "gitBaseSha": "<sha-at-start>", "startedOn": "<iso>", "finishedOn": "<iso>" },
      "routingDecisions": [ /* tree, keyed by agentId; recommendationId non-null iff routed online-unpinned */ ],
      "costSummary": { "actualCostUsd": 0.041, "allPremiumCostUsd": 0.31, "savingsPct": 86.7,
                       "judgedTurns": 3, "totalTurns": 12 },       // honest coverage
      "byproducts": [ { "name": "session.jsonl", "digest": {"sha256":"<hex>"}, "uri": "session.jsonl" } ],
      "taskState": "completed"                                     // A2A: submitted|working|input-required|completed|failed|canceled
    }
  }
}
```

DSSE PAE = `"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload`. Bundle: `record.json` (DSSE) · `session.jsonl` · `changes.diff` · `CONTINUATION.md` · `cost-report.txt` · `manifest.json` · `minima-signing.pub`. CLI verbs: `minima export|resume <bundle>|verify <bundle>` via a new `argv[0]` branch in `cli/main.ts` alongside `config`/`auth`.

---

## 7. Metrics (proves the thesis)

**Grounded seams (verified).** All oracle inputs live in `routing.ranked[]` (`predictedSuccess`, `estCostUsd`, `successIntervalWidth`, `evidenceCount`) + `thresholdUsed`. `judge.grade()` returns `number|null`; a `DeterministicJudge` class exists.

### Corrections folded in

- **Baseline was wrong, not just missing.** `router.baselineCost()` returns the `config.baselineModelId` candidate (default **null**), **not** `max(estCost)`. So savings-vs-all-premium is **undefined out of the box**. **Fix:** compute `all_premium_cost_usd = max(ranked[].est_cost)` at persistence time (see DDL); keep the configured-baseline as a separate column; the eval harness's `all-premium` arm is the only fully honest anchor.
- **The oracle is circular / self-grading.** `learnedSuccess` is derived from the same history that produced `predictedSuccess`, and non-chosen candidates have **no realized outcome** for that task. **Fix:** (1) train `learnedSuccess` on a **time-split/held-out** slice; (2) credit a cheaper candidate only if it clears τ **with a confidence gate**: `learnedSuccess − k·successIntervalWidth ≥ threshold_used` **and** `evidence_count ≥ N` — else EXCLUDE it (do **not** fall back to the chosen model's estimate); (3) report **observed-evidence OCR** with the fraction of decisions that had a real counterfactual; (4) anchor the **published** proof number on the **3-arm replay** (every arm actually runs), not the production offline projection.
- **QpD denominator hygiene.** Define eligibility explicitly:
  - `qpdEligible(r) = r.quality != null && r.actual_cost_usd > 0 && r.judged == 1` (excludes cadence-skips and abstains; **includes** `quality=0` failures — do not silently drop them).
  - `ocrEligible(r) = r.rec_id != null && r.ranked.length > 0 && r.threshold_used > 0` (excludes pinned/offline). Report unrouted spend as a separate line so it doesn't deflate OCR.
- **Split quality units.** Report **verified-QpD** (deterministic checker, eval only) and **judged-QpD** (LLM judge, production) as distinct figures. Pin `judgeEvery=1` for any published run; report graded-coverage alongside.
- **Persist per-turn durably** (one row per `promptRouted` in a `finally`) so crash/abort keeps completed rows; aborted turns record as `failure` with partial cost.
- **P3 "15x pays for itself"** compares an **estimate** (`recommendWorkflow`'s `total_est_cost_if_all_premium`) against a **realized** dynamic spawn. **Fix:** build the multi-agent baseline from a **realized all-premium replay** of the same spawned DAG, or label the claim estimate-based and validate against one realized run. Gate on Pillar 1 spawn + Pillar 2 budget existing.

### Metric functions

```ts
function qualityPerDollar(rows: R[]): number {
  const g = rows.filter(qpdEligible);
  return sum(g.map(r => r.quality!)) / sum(g.map(r => r.actual_cost_usd));
}
function oracleCost(r: R, learned: (m,t,d)=>{p:number,w:number,n:number}): number | null {
  const viable = r.ranked.filter(c => {
    const s = learned(c.model_id, r.task_type, r.difficulty);
    return s.n >= MIN_EVIDENCE && (s.p - K * s.w) >= r.threshold_used;
  });
  return viable.length ? Math.min(...viable.map(c => c.est_cost_usd)) : null; // null ⇒ no counterfactual
}
function optimalCostRatio(rows: R[], learned): { ocr: number; coverage: number } {
  const e = rows.filter(ocrEligible).map(r => ({ r, oc: oracleCost(r, learned) })).filter(x => x.oc != null);
  return { ocr: sum(e.map(x => x.oc!)) / sum(e.map(x => x.r.actual_cost_usd)),
           coverage: e.length / rows.filter(ocrEligible).length };
}
```

**Eval harness (record/replay):** fixed `EvalCase[]` (5–10 real repo fixtures, deterministic checkers), canned `RecommendResponse` fixtures (fixed `ranked[]`+costs) and a `DeterministicJudge` for **all** eval rows so P2 reproducibility holds. Arms: `all-premium | all-cheap | minima-routed | multi-agent-routed`.

---

## 8. Client vs Hosted-Minima boundary (the contract)

| Decision | Owner | Why | Mechanism |
|---|---|---|---|
| Decompose goal → step DAG | **Hosted** `POST /v1/plan` (**NEW**) | Stateless pure function of goal+budget+pool; belongs where routing intelligence lives | Returns `steps: Delegation[]` + `budget_allocation[]` |
| Allocate budget across steps | **Hosted** `/v1/plan` | Same | Per-step `budget_usd` |
| Model-tier per step | **Hosted** `/v1/recommend/workflow` (dormant, wire it) | Already returns `total_est_cost_usd` vs `total_est_cost_if_all_premium` | Per-step `Constraints` merged over global |
| Per-turn model pick | **Hosted** `/v1/recommend` | classify → τ → posterior-sample cheapest ≥ τ | `ranked[]` ladder |
| **DAG execution** | **Local** | Server is stateless per-request (`engine.py`), holds no ledger/FS/worktrees | Orchestrator + `SpawnFn` |
| **Spawn / isolation** | **Local** | Needs mutable FS + worktrees + process | per-child `MinimaAgent` |
| **Budget ledger enforcement** | **Local** | Needs running-spend state; server has none | `BudgetLedger` + `shouldStopAfterTurn` |
| **Cascade retry** | **Local** | Needs judge signal + message rollback | `ranked[]` walk |
| **Event multiplexing / TUI** | **Local** | Ink + subscribers | `ChildEvent` |
| **Durable record / MWR** | **Local** | SQLite + git + signing | `MinimaDb` + `provenance/` |
| Org-level savings aggregation, cross-run lessons, bandit training | **Hosted DB/Mubit** | Cross-user/cross-run | sync on `rec_id` |

```ts
// NEW client method — packages/tui/src/minima/client.ts
interface PlanRequest  { goal: string; budget_usd: number; candidate_models?: string[];
                         cost_quality_tradeoff?: number; repo_context?: string; }
interface PlanResponse { plan_id: string; steps: Delegation[];
                         budget_allocation: { step_id: string; budget_usd: number }[]; }
// class MinimaClient { plan(req): Promise<PlanResponse> { return this.post("/v1/plan", req); } }
```

**Offline degradation:** `/v1/plan` is **optional**. If unreachable, fall back to harness-side single-agent execution (no DAG) or a trivial local decomposition, surfaced clearly. P1/P2 (harness-driven fan-out) work with **zero server dependency**; only P3-planner needs it. **Open question (confirm before P3):** does `/v1/plan` exist server-side, or is it net-new in ricedb? The engine is stateless-per-request today and does **not** plan steps.

---

## 9. Unified data model & the `recommendationId` join key

One identity: **`{project_key = repoIdentity(cwd), run_id = newId()}`** with `runs.project_key` FK. This retires the three uncoordinated schemes (repoIdentity for memory, ephemeral hex `sessionId`, cwd-slug). `agent.sessionId` (provider prompt-cache key) is stored as `runs.provider_session_id`, **not** used as PK.

**`recommendationId` (`rec_id`) is the single join key** across all tiers:
- Local: PK of `routing_decisions`.
- Hosted `POST /v1/feedback`: keyed by `recommendation_id` (already).
- Mubit `recordOutcome`: `idempotency_key`/`reference_id = recommendationId` (already).
- Sync: `synced=1` marking is idempotent on `rec_id` — offline writes reconcile exactly once.

Null-key rows (pinned/offline) get a local synthetic id for the DB row but are **excluded** from OCR/hosted reconciliation and reported as unrouted spend.

---

## 10. Roadmap (dependency-ordered, sized for a small team)

**The universal prerequisite (Move #1): the routing DecisionRecord writeback.** Nothing computes a metric or emits provenance until it lands.

### Phase 0 — Foundation (thin-slice MVP core) — *~2–3 wk*
- **P0a Isolation prerequisites** (no behavior change): instance-field `todoState`; `workdir` base + path-confinement in `read/edit/write/glob/grep`; one-time catalog bootstrap.
  - *Gate:* two agents in one process keep independent todos + distinct workdirs + reject `..` escape; existing tests + `tsc`/lint green.
- **P0b Persistence write path** (**the prerequisite**): `MinimaDb` (bun:sqlite, WAL, schema v1, migration runner, `busy_timeout`); DbSink on `subscribe()` with the `toolCallId→{name,args}` map; DecisionRecord writer at `promptRouted` (idempotent on `rec_id`); `startRun`/`finishRun`; identity unified to `{project_key, run_id}`; per-turn transaction.
  - *Gate:* after a real routed run, `SELECT count(*)` over `routing_decisions` == #prompts, each row has `all_premium_cost_usd` + `rec_id` + non-empty `ranked[]`; process exit loses nothing; `writeDecision` idempotent.

### Phase 1 — Sequential spawn + metric primitives + rehydration — *~3 wk*
- **P1a taskTool (depth-1, sequential)** + default `SpawnFn` + `ChildEvent` envelope + abort listener + DAG validation + malformed-delegation rejection. `builtinTools({spawn, spawnDepth, maxDepth=1})` [API CHANGE to call sites].
- **P1b Metric primitives** (`qualityPerDollar`, `oracleCost` with confidence gate, `optimalCostRatio`+coverage) over `routing_decisions`; `/cost` and `minima report` print QpD + savings-vs-all-premium + OCR.
- **P1c Rehydration:** `rehydrateRun()` restores messages + `CostMeter.rows` + `promptsRun`; back `/name`,`/resume` with real ops.
  - *Gates:* lead delegates one subtask, child routes on its own model in its own workdir, returns text; malformed/cyclic delegation rejected; resume shows cost footer + routing history (not zeroed); `/name` survives reload; hand-computed regret matches on a 3-row fixture; abstain/cadence-skip excluded from QpD, `quality=0` failures included.

### Phase 2 — Budget enforcement + DAG fan-out — *~4 wk*
- **P2a BudgetLedger** (session→subtask, synchronous reserve/reconcile, corrected worst-case formula) + **[API CHANGE]** `setShouldStopAfterTurn` (or per-run override) + running-sum stop closure. Shadow → warn → enforce; 90%→warn+continue in non-interactive, 100%→`abort()`. Dead-key reroute at `promptRouted` level.
- **P2b recommend() [API CHANGE]:** `max_cost_per_call` + `min_quality` + `difficulty`; authoritative `providerKeyPresent` pool.
- **P2c DAG + bounded fan-out:** Orchestrator topological exec under a **semaphore** (global + per-provider); `depends_on`; per-node difficulty routing; opt-in worktree per editing node; lead-owned merge node; partial-failure semantics.
  - *Gates:* tight USD cap stops cleanly at 100% (no partial-tool corruption), warns at 75/90; "refactor N modules" fans out to N children in isolated workdirs with no clobbering, merged deterministically; regret-vs-`all_premium` computed; concurrency cap holds under a wide frontier.

### Phase 3 — Cascade + auto-tune + hosted planner + semantic recall — *~4 wk (later)*
- **P3a Cascade:** escalate on non-null judge < τ up `ranked[]` within remaining budget; full-loop message snapshot/rollback; feedback reflects the winning attempt; record `cascadeAttempts`.
- **P3b Auto-tune slider** by spent-fraction (75/90 clamps).
- **P3c Hosted planner:** `MinimaClient.plan()` → `/v1/plan` (**confirm server scope**), executed by the harness via `recommendWorkflow`; offline fallback to single-agent.
- **P3d Semantic recall** (capability-gated `sqlite-vec`; else Mubit network fallback); bi-temporal lessons.
  - *Gates:* a node the cheap model fails auto-escalates and recovers; a budget-only goal gets a hosted DAG executed under budget with cost-vs-all-premium reported; recall <100ms local or graceful network fallback.

### Phase 4 — Provenance + live TUI tree + positioning — *~4 wk (later)*
- **P4a MWR:** projection → in-toto Statement; unsigned bundle + split `verify` (integrity vs advisory reconciliation); then DSSE signing + TOFU keyring; `resume` with `git apply --3way`; `CONTINUATION.md`; redaction pass; in-toto conformance test.
- **P4b Live TUI sub-agent tree:** `ChildEvent` consumer keyed by `childId/parentId/depth` in a **separate panel** (no transcript demux corruption); unsubscribe on completion; coalesce events above a fan-out threshold; budget footer (spent/reserved/remaining) via `ledger.onEvent`; `/budget` mirroring `/cost`.
- **P4c Positioning & multi-agent metric:** realized all-premium multi-agent replay; embed savings/OCR into the signed MWR; table-stakes checklist.
  - *Gates:* `minima verify` passes on untouched bundle, fails on tampered payload/wrong key/mutated byproduct; cross-machine verify with bundled pubkey (TOFU warn); live fan-out renders a tree without corrupting the top-level transcript; PAE golden vectors pass against a reference verifier.

**MVP line:** Phases 0–2 are the shippable thin slice that already delivers the differentiator (per-worker cost-aware routing under an enforced budget with a durable, queryable record). Phases 3–4 are the moat (cascade savings, hosted planning, signed provenance, live tree).

---

## 11. Risks / failure-modes & the metrics that prove we've addressed them

| # | Risk / failure mode | Where it bites | Mitigation | Metric / gate that proves it |
|---|---|---|---|---|
| R1 | **DecisionRecord writeback never lands** → nothing downstream computable | Whole program | P0b is the hard gate before any other phase | `count(routing_decisions)==#prompts`, each row has `rec_id`+`ranked[]` |
| R2 | **Parallel children clobber FS / race `todoState`/`REGISTRY`** | Pillar 1 | Instance-field todo; per-child workdir + path confinement; one-time catalog bootstrap | Two-agent isolation test; N-module fan-out with no clobber |
| R3 | **Abort tree broken** — Ctrl-C / budget-exhaust can't stop in-flight children | Pillars 1–2 | `parentSignal → child.abort()`; node timeout; budget-100% → `abort()` | Kill-mid-fan-out test: all children stop; token burn ceases |
| R4 | **Budget overshoots within a turn** (post-turn stop only) | Pillar 2 | Worst-case reserve pre-commits one turn's ceiling; `abort()` kills in-flight at 100% | Tight-cap E2E stops at 100% with no partial-tool corruption |
| R5 | **Cascade loops / escalates on abstain** | Pillar 2/3 | Escalate only on non-null score < τ; cap by `maxEscalations` **and** remaining budget | Cascade recovers a cheap-model failure once; never on null |
| R6 | **Dead key silently burns budget** | Pillar 2 | Reroute at `promptRouted` on `stop_reason==='error'`; `excludedProviders` set; reconcile failed reserve | Revoke-key-mid-run test: turn rescued on alternative, dead provider not retried |
| R7 | **429 / worktree / Ink storms at wide fan-out** | Pillar 1 | Semaphore (global + per-provider); worktree cap; ChildEvent coalescing above threshold | Wide-frontier test: bounded concurrency, no rate-limit failures |
| R8 | **Concurrent writers corrupt the DB** | Pillar 3 | WAL + `busy_timeout`; per-turn transaction; single serialized writer or per-child branch | Parallel-write stress test; no `SQLITE_BUSY` data loss; `degraded` flag on partial |
| R9 | **Resume silently resets budget / loses cost state** | Pillars 3–4 | `rehydrateRun()` rebuilds `CostMeter.rows` + spent; persist per-scope spend | Round-trip export→resume asserts CostMeter totals + routing history byte-equal |
| R10 | **Vanity oracle (circular self-grading)** | Metrics | Held-out training slice; confidence gate + evidence floor; publish OCR **coverage**; anchor on 3-arm replay | OCR reported with coverage; replay ArmResult reproducible twice |
| R11 | **Savings/QpD undefined by default** (null baseline, `ConstJudge`, cadence) | Metrics | `all_premium = max(ranked.est)`; split verified-/judged-QpD; `judged n/m` in record; pin `judgeEvery=1` for published runs | Report shows QpD>0, OCR∈(0,1], graded-coverage; savings vs `all_premium` non-null |
| R12 | **Signed bundle leaks secrets** | Pillar 4 | Redaction pass over jsonl/diff/brief; `redactionCount` in predicate | Redaction test: seeded secret never appears in bundle |
| R13 | **Verify is brittle on dirty/diverged tree** | Pillar 4 | Split verify: integrity (hard) vs reconciliation (advisory); `git apply --3way` on resume; temp `GIT_INDEX_FILE` | Tamper matrix passes; diverged-tree resume applies diff or reports conflict, never mutates index |
| R14 | **Trust overclaim** (self-signed ≠ identity) | Pillar 4 | TOFU keyring + WARN on unknown keyid; keyless deferred, documented | Cross-machine verify warns on unknown signer |
| R15 | **P3/P4 native-extension packaging fails in compiled binary** | Pillar 3 | Runtime `loadExtension` capability check → Mubit network fallback; per-platform vendoring | `bun build --compile` binary: recall falls back gracefully offline |
| R16 | **15x-tax claim rests on estimate-vs-realized mismatch** | Metrics/P3 | Realized all-premium multi-agent replay as baseline | multi-agent QpD ≥ single-agent QpD at strictly higher success_rate on comparison cases, else claim withheld |

**Headline metrics (the proof artifact):** per run and per repo — **Quality-per-Dollar** (verified-QpD + judged-QpD, with graded coverage), **Optimal-Cost-Ratio** (OCR ∈ (0,1] with counterfactual coverage), **regret-USD** vs the confidence-gated oracle, and **savings vs all-premium** (`max(ranked.est_cost)`). Published number is the reproducible 3-arm (+ multi-agent) `ArmResult` table.

---

## 12. Open questions to resolve before committing later phases
1. Does `/v1/plan` exist server-side, or is it net-new ricedb work wrapping the existing `recommend` levers? (Gates P3c; engine is stateless-per-request and does not plan today.)
2. Worktree merge-conflict policy: deterministic lead merge node with re-plan-on-conflict — confirm `EnterWorktree`/`ExitWorktree` schemas via ToolSearch and non-git fallback.
3. `maxDepth=2` sufficient, or do some tasks need deeper trees? (Token-tax value gate.)
4. Embedding model/dimension for `lesson_vec` (assume `float[384]` MiniLM-class); generated locally or fetched from Mubit? (Affects offline recall.)
5. One `.db` per `project_key` vs one global DB with a `project_key` column (per-project maps to Turso branching; global eases cross-project analytics).
6. `schema_meta.version` skew during sync: client-owned migrations vs server-authoritative.