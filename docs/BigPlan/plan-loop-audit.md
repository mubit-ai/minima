# Plan-loop E2E audit (MP13 / MUB-156)

The Ground-Truth spine, walked end-to-end as built and asserted row-by-row:
plan finalize → ledger seed → todowrite w/ verify → baseline red → execute → blocked
completion → escalation → red→green → done-gate → milestone → grounded outcome →
`/v1/feedback` with realized usage.

Every claim below is executable: `bun test tests/plan-loop-audit.test.ts` (3 tests,
hermetic — faux provider, in-process mock service, temp-dir DB). Rows as of 2026-07-17 @
`mp13-plan-loop-audit`; regenerate by re-running the test and dumping the temp DB.

## The trace (what actually lands, table by table)

A two-step plan is finalized from a `PlanSessionStore` (canned council round + injected
synthesis; step 0 carries `verify: test -f <tmp>/demo.flag`, step 1 has no verify). The
agent runs two rungs: rung 1 (cheap-model) starts step 0, baseline runs **red**, writes two
on-plan files, then claims completion while still red — the done-gate **blocks** the
todowrite. Rung 2 (big-model, escalation) creates the flag, completes both steps — gate
passes red→green, plan closes.

**plans** — one row, `active` at seed → `done` + `closed_at` stamped at closure.

**plan_steps**:

| idx | content | status | verify | baseline | check_origin |
|---|---|---|---|---|---|
| 0 | produce the audit outputs demo.txt and demo.flag | completed | `test -f <tmp>/demo.flag` | red | user |
| 1 | record the audit summary notes | completed | NULL | NULL | NULL |

`check_origin="user"` because the user approved the plan at finalize
(`seedPlanFromSteps`, `minima_db.ts:1022`) — and the gate later honors the STORED origin
over gate-time classification (`ground_truth.ts:993`).

**gates** — four rows, in order:

| kind | outcome | confidence | verified_by | rec_id | step | key factors |
|---|---|---|---|---|---|---|
| step_check | failed | NULL | deterministic | rec-1 | 0 | `pass:false, hasCheck:true, checkOrigin:user, exitCode:1` |
| step_check | verified | NULL | deterministic | rec-2 | 0 | `pass:true, redToGreen:true, coverageHit:"unknown"` |
| step_check | unchecked | NULL | NULL | rec-2 | 1 | `hasCheck:false, checkOrigin:"agent_new"` |
| milestone | unchecked | yellow | NULL | rec-2 | — | `{milestone:true, steps:2, verified:1}` |

The blocked attempt is durable **before** any recovery runs (written in the before-hook,
`ground_truth.ts:1030-1051`, because a blocked call's after-hook never fires) — verified by
a mid-loop snapshot between rungs.

**file_changes** — both rung-1 writes attributed `origin:"on_plan"`, `step_id` = step 0,
`agent_id` NULL (lead agent).

**routing_decisions** — two rows:

| rec_id | model | outcome | gt_outcome | gt_confidence | step_id | parent_rec_id | actual_cost_usd |
|---|---|---|---|---|---|---|---|
| rec-1 | cheap-model | failure | failed | red | step 0 | NULL | 0.000014 |
| rec-2 | big-model | partial | verified | **yellow** | **NULL** | rec-1 | 0.00008 |

**/v1/feedback** — two payloads, judge off, grading fully deterministic:

```json
{"recommendation_id":"rec-1","chosen_model_id":"cheap-model","outcome":"failure",
 "output_tokens":7,"actual_cost_usd":0.000014,"latency_ms":10,"iterations":4,
 "verified_in_production":false,"judged":false,"notes":"verified_by=deterministic;tier=red"}
{"recommendation_id":"rec-2","chosen_model_id":"big-model","outcome":"partial",
 "output_tokens":4,"actual_cost_usd":0.00008,"latency_ms":3,"iterations":3,
 "verified_in_production":false,"judged":false,"notes":"verified_by=deterministic;tier=yellow"}
```

Why **yellow**, not green, on a genuine red→green: `test -f <flag>` names no test file, so
`computeCoverageHit` returns `"unknown"` (`gt_factors.ts:251-270`) and the tier logic
withholds green when it can't tell the check touches the changes (`confidence.ts:19-21`).
Downstream, honestly: A7 grades yellow-verified to `partial` and `verified_in_production`
stays false (green-only, `runtime.ts:857`). Feedback-truth holds — nothing fabricated
anywhere in the trace.

## Findings

Severity: ● bug · ◐ design wart, decide · ○ dead weight / documentation.

- **AUD-1 ● The closing rung loses its `step_id` stamp.** Plan closure runs in the
  todowrite after-hook mid-prompt; by the time `persistDecision` reads the in-progress step
  (`runtime.ts:605-608`) `getActivePlan` is null → rung-2 `step_id` NULL. `stepCosts`
  (`minima_db.ts:842`, the U3 per-step $ panel) permanently undercounts the final — usually
  most expensive — rung of every plan.
- **AUD-2 ● Milestone rollup is `unchecked` whenever ANY step is verify-less.**
  `writeMilestoneGate` (`ground_truth.ts:766-775`) demands every terminal step gate
  `verified`; one unchecked step (here: a notes step) downgrades a plan with real red→green
  evidence to an `unchecked` milestone. Mixed plans are the norm — the rollup should
  probably distinguish "some unchecked" from "nothing verified".
- **AUD-3 ◐ `input_tokens`/`output_tokens` use `|| undefined`** (`router.ts:279`) — a
  genuine 0 is dropped from the feedback wire. Cosmetic today (real providers report
  usage), but it's a feedback-truth wart: absence and zero are different claims.
- **AUD-4 ◐ `parent_rec_id` is a flat star, not a chain** — every escalation rung points at
  the FIRST rung (`runtime.ts:485`). With ≥3 rungs the ladder order is unrecoverable from
  the column. Also write-only: no production reader.
- **AUD-5 ◐ `gates.confidence` is NULL-on-write for live step_check rows** (both hook
  writers pass null; the tier is derived at read from `factors_json` via `gateVerdictFor`).
  The column is load-bearing ONLY for milestone rows — whose `factors_json` doesn't parse as
  `Factors`, so their verdict rests entirely on the stored column. Two verdict channels,
  each half-used.
- **AUD-6 ◐ `uncheckedFactors()` hardcodes `checkOrigin:"agent_new"`**
  (`ground_truth.ts:704-713`) for steps that have no check at all — misleading provenance
  in the ledger (harmless today only because `hasCheck:false` caps everything first).
- **AUD-7 ● Headless `-p` executes LLM-authored verify with zero consent.** With hooks
  wired exactly as `main.ts` builds them (no permission surface at all in non-interactive
  mode), `verify: touch <dir>/consent-leak` executed on the host at baseline the moment its
  step went in_progress — asserted, file exists. **→ MP18 (MUB-161) fixes this at the
  wiring layer**; the test pins today's truth and stays valid after (library default).
- **AUD-8 ◐ Sub-agents bypass the permission hook entirely** (`spawn.ts:172` — children get
  only the attribution sink). GT hooks are lead-only so children run no verifies; the
  exposure is unconsented writes/bash in build mode via `task` delegation. Plan mode already
  hard-blocks `task` for exactly this reason.
- **AUD-9 ○ Sticky verify is overwrite-only** — omission keeps the stored command
  (COALESCE), a swap voids the baseline (`minima_db.ts:1303-1306`), and there is NO revoke
  path: once a step has a check it can never become check-less. By design (a gate you can
  delete isn't a gate), now documented; MP18's execution-time consent keying makes the swap
  path safe.
- **AUD-10 ○ Write-only constants**: `routing_decisions.synced` (always 0, no reader/updater)
  and `schema_v` (hardcoded 2, no reader) — pinned by test. `plans.closed_at` and the
  `gt_*` stamps are locally write-only (intended for the hosted work record; feedback
  derives from `gates` directly, not the stamps). Candidates for a cleanup MP or an explicit
  "reserved for sync" comment in the schema.
- **AUD-11 ○ Blocked-call evidence asymmetry, by design**: the failed gate row is the ONLY
  durable evidence of a blocked completion (rung rollback erases the rung's messages) —
  state-in-the-DB working exactly as the design principles demand; noted so nobody "fixes" it.

Precedence checks that behaved exactly as specified: deterministic gate outranks the judge;
judge-off cadence leaves `judged:false` with realized cost still reported; red gate on a
transient-free rung yields `failure` label; grading yellow-verified → `partial`.

Repo hygiene footnote: `tsconfig include` covers `src/**` only — `bun run check` never
typechecks `tests/`; the audit file was strict-checked manually.

## Disposition

Per the guide (§10 MP13): findings become new MPs appended to Track W, not scope creep here.
Proposed: **AUD-1 + AUD-2** are small, real bugs worth one combined MP (closing-rung
step stamp + milestone rollup semantics); **AUD-7** is already MP18; **AUD-3/4/5/6/10** fold
into one ledger-hygiene MP (decide + clean in a single migration-free pass); AUD-8 needs a
product decision on child-agent consent scope; AUD-9/11 are documentation, done by this file.
