# bench/ — Minima harness scripted test flows

Scripted end-to-end flows that drive the **installed** `minima` binary (Homebrew, currently
0.7.1) the way a user would — headless one-shots and full interactive PTY sessions — and
assert on the artifacts the harness actually produces: the SQLite DB, the transcript, git
state, and server responses. Born from the 2026-07-06 demo/test-flow research plan
(14-agent inventory + web research + 3 designs + 2 adversarial critiques).

## Why this exists

We want to demo every Minima harness feature and regression-test the full loop
(recommend → run → judge → feedback → memory) with **long conversational sessions on
disposable test dirs**, one session id per flow. No such infrastructure existed: the repo
had only in-process bun tests (faux provider) and two live smoke scripts.

## Layout

```
bench/
  driver/
    rig.ts          PTY rig — spawns the TUI in a real pseudo-terminal via Bun.spawn
                    {terminal} (Bun >= 1.3.5), accumulates output, regex wait/assert,
                    types + submits prompts and slash commands
    headless.ts     one-shot runner for --print / --mode json invocations
    mock_server.ts  scripted /v1 Minima server (recommend/feedback/models/capabilities)
                    with full request capture — makes offline/reconnect + ladder flows
                    deterministic and free
  assert/
    db.ts           readonly bun:sqlite helpers over the harness DB
                    (runs / routing_decisions / budgets / budget_events / tool_calls)
    check.ts        assertion collector → per-flow PASS/FAIL report
  flows/
    f1_headless.ts          F1: headless CLI battery (exit codes, routed/pinned/offline
                            rows, JSON-event contract, budget deny)
    f9_offline_reconnect.ts F9: offline fallback → mock server comes up → /reconnect →
                            routed=server (deterministic, no config writes)
    f4_cost_budget.ts       F4: PTY session — /budget set/mode ladder (warn → enforce
                            refusal → warn → shadow), /clear display-only lock-in,
                            /cost, context retention
  gen/
    materialize.ts    template + patches → agent-visible working copy (git HEAD = seeded
                      state; hidden tests applied only at grade time)
    validate_task.ts  the 5 execution gates every task must pass (SWE-bench-Verified
                      style): template green → bug invisible to public suite → hidden
                      tests fail pre-fix → oracle restores green → statement >= 40 words
    calibrate.ts      k-run empirical difficulty calibration: pinned cheap/frontier arms
                      through the installed binary, cheat-guarded hidden-test grading,
                      appends bench/tasks/calibration.jsonl
    build_index.ts    task dirs (+ calibration rates when present) → bench/tasks/tasks.jsonl
  fixtures/templates/ clean fixture repos (py-cli, ts-api, js-lib, katas; _example is the
                      canonical reference the validator smoke uses)
  tasks/<repo>/<id>/  task instances: task.json, bug.patch?, hidden_tests.patch, oracle.patch?
  run.ts            entry point: `bun bench/run.ts f1 f9 f4`
  artifacts/        (gitignored) per-run scratch dirs, DBs, transcripts on failure
```

## The session recipe (validated live 2026-07-06)

There is **no CLI flag** to pin or resume a session id in 0.7.1. The only supported
recipe, validated against the installed binary:

```sh
cd <disposable-dir>                       # NEVER a real repo: headless mode has ZERO
                                          # permission gating (hook only wired in the TUI)
MINIMA_DB_PATH=<flow>.db \
MINIMA_NAMESPACE=bench-<flow>-<id> \
minima -nt --budget 0.05 --budget-enforce -p "..."
sqlite3 <flow>.db "SELECT run_id,status FROM runs"   # ← captured session id
```

One DB path per flow (one per case for headless batteries) removes all "newest run"
ambiguity. Multi-turn = PTY-drive the interactive TUI; `/resume <FULL run_id>` after
restart (exact match — the picker's 12-char ids are display-only).

## Task dataset (Phase B, 2026-07-06)

**33 execution-validated tasks** across 4 purpose-built fixture repos (34 counting the
`_example` reference), authored by a 4-agent fan-out and independently re-validated
(`bun bench/gen/validate_task.ts --all` → 34/34):

| repo | template | tasks | mix |
|---|---|---|---|
| `py-cli` ("taskman") | ~1.2k LOC argparse CLI, 60 pytest tests | 8 | 3 easy + 3 medium + 1 hard (cross-module schema-migration data loss) + 1 **trap** (168-word panic statement, 1-line fix) |
| `ts-api` ("linkbox") | ~1.6k LOC bun HTTP handlers, 60 tests | 7 | 3 feature-adds (hidden-test spec) + 3 medium bugfixes + 1 **trap** (casual statement, diagnosis spans store/persist/stats) |
| `js-lib` ("datakit") | ~0.8k LOC zero-dep utils, 50 tests, fastest suite | 6 | 2 easy + 2 medium + 1 feature + 1 hard (CSV round-trip state machine) |
| `katas` | 12 single-file stubs (4 py / 4 ts / 4 js) | 12 | all trivial → the unambiguous cheap tier |

**Difficulty labels are EMPIRICAL** (k=5 × cheap(haiku)/frontier(sonnet) arms, 330
attempts, $17.90, 0 errors, 0 cheats — `calibration.jsonl`, report via
`gen/calibration_report.ts`). The 2026-07-06 full pass rewrote the structural bins:

- **haiku solves 30/33 tasks at ~100%** — well-specified, symptoms-only bugfixes in
  1-2k-LOC repos are simply within a 2026 cheap model's reach, including the authored-
  hard 72-line cross-module migration (pc-007: 5/5 cheap). 12 authored-medium/hard
  tasks were NO-SIGNAL (both arms 5/5) → re-labeled easy/cheap with
  `authored_difficulty` preserved.
- **jl-006 is the perfect hard task**: cheap 0/5, frontier 5/5 (CSV state-machine
  round-trip) — the escalation-value demo in one row.
- **ta-004 is a cheap-beats-frontier anomaly**: cheap 4/5, frontier 0/5 — sonnet
  consistently fails a task haiku solves (kept medium, route=cheap, flagged for
  failure-mode investigation; excellent routing-demo material).
- Final spread: 12 trivial / 19 easy / 1 medium / 1 hard; expected_route: 32 cheap,
  1 frontier. **Consequence for the demo:** this dataset proves the savings story
  (quality parity at cheap prices) overwhelmingly, but differentiated escalation
  routing rests on jl-006/ta-004 alone — a "genuinely hard" authoring round (vaguer
  statements, composite multi-bug patches, larger repos) is queued for the demo phase.

Anti-leakage: agents under test see ONLY the materialized template (+ seeded bug) and
the `problem_statement` — never `task.json` (whose `notes` describe the defect), never
`hidden_tests.patch`. Statements are symptoms-only for bugfixes (audited: no defect
file/function names, no fix quotes); feature statements specify routes/signatures.

## Savings A/B (Phase D, 2026-07-06) — the honest headline

Paired protocol per router-eval best practice: all 33 tasks fresh-executed twice
(identical prompts, fresh checkouts, hidden-test graded) — arm A pinned
`claude-opus-4-8` (all-premium baseline), arm B **routed** via api.minima.sh
(namespace `bench-ab-v1`, feedback live). Runner: `gen/savings_ab.ts` · report:
`gen/savings_report.ts` · raw log: `tasks/savings_ab.jsonl`. Total run cost $8.71.

```
1. COST   premium: $7.89 total, $0.2546/completed
          routed:  $0.82 total, $0.0302/completed   → 89.7% saved
2. PARITY premium 31/33 (93.9%) vs routed 27/33 (81.8%)
          both=26 · premium-only=5 · routed-only=1 · neither=1
          McNemar exact p=0.219 — no significant difference at n=33
3. ROUTED DISTRIBUTION: gemini-2.5-flash × 33 (cold-prior argmin; no escalation)
```

Present all three together, never % saved alone; state the n=33 parity bound (±10-15pp).
Noteworthy pairs: jl-003 is a cheap-beats-premium case (flash PASS $0.008, opus FAIL
$0.40); the 5 routed-only failures are all tasks haiku solved 5/5 in calibration —
i.e. flash-specific misses on a cold prior, exactly the signal the learning loop
should absorb (F12 tests that transition).

**Finding — the server's premium counterfactual understates reality ~10×**: summed
`all_premium_cost_usd` estimates for the routed arm came to $0.77 vs the MEASURED
premium arm's $7.89. Single-call token estimates don't capture multi-turn agentic
tool loops. Real savings are LARGER than /v1/savings claims, but the estimate is not
a credible counterfactual for agentic workloads — measured paired baselines are.
(Feeds the GT-8 observed-best/IPS work.)

## Learning loop (F12) — currently blocked SERVER-side

`flows/f12_learning_loop.ts` (live-lane, ~$0.60/run when writes are healthy): first a
free WRITE-HEALTH probe (direct recommend→feedback, hard check on the feedback BODY's
`accepted` field, early-exit on failure), then warms a fresh namespace with 8 judged
kata runs (separate sessions) and re-runs 4 of the SAME tasks as probes in warm-vs-cold
namespaces.

- **ROOT CAUSE FOUND (2026-07-06, direct API probe): the server rejects every memory
  write.** `POST /v1/feedback` returns HTTP 200 with `accepted=false, record_id=null,
  warnings=["memory_write_failed"]`; recommends carry `memory_unavailable`
  intermittently (it was absent during the post-0.7.2 F12 run — a red herring that
  briefly pointed suspicion at thresholds). With zero writes landing, the prior→memory
  flip can never happen; every earlier F12 failure traces to this.
- The harness swallowed the rejection: `MinimaAgent.lastFeedbackError` captured it but
  nothing read the field (fixed in PR #84 — TUI info line + `--mode json`
  `feedback_error` event). F12's write-health check asserts on the response body
  directly, so it needs no new binary and fails in <1s at the true cause.
- Next hop: the Minima↔Mubit boundary — the write fails inside the server's
  `remember_outcome` → Mubit ingest path (the repo `.env` key is `mbt_local_admin`,
  the dev key with known api.mubit.ai instance-routing problems). Definitive local
  experiment: run the server against a local ricedb (where that key is valid) and
  repeat the probe; if it closes locally, it's Mubit-side instance routing for the
  key, not this repo. Server hardening sketch (separate PR): validate ingest-job
  `writes[].success` in `memory/adapter.py` instead of treating a done-job-with-failed-
  writes as success; surface the parsed-but-unread `recall.degraded`.
- Consequence: the demo's "learning over time" beat stays blocked until writes land
  for the demo key. F12 flips green by itself when they do.
- Also noteworthy: routing drifted flash→pro for identical kata prompts within hours
  (catalog/prior drift) — validates the suite-wide rule of never asserting model ids.

## Running

```sh
bun bench/run.ts            # all flows
bun bench/run.ts f1 f9      # a subset

bun bench/gen/validate_task.ts --all        # re-validate every task (local, free)
bun bench/gen/calibrate.ts --tasks all --arms cheap,frontier --k 5   # full calibration (costed)
bun bench/gen/build_index.ts                # rebuild tasks.jsonl (+ measured rates)
```

Live-lane cost: the full Phase A suite spends well under $0.10/run (trivial prompts,
mock server wherever determinism matters). Exit code is non-zero if any hard check fails;
per-flow transcripts land in `bench/artifacts/scratch/<flow>-<ts>/transcript.txt`.

Status (2026-07-06): **full suite 7/7 flows PASS — f1 30/30 · f9 11/11 · f4 16/16 ·
f5 5/5 · f6 6/6 · f7 13/13 · f10 5/5 (86 hard checks)** against installed 0.7.1 +
hosted api.minima.sh; ~3.3 min, ~$0.15/run.

## Findings log

Datestamped facts discovered while building/running the flows — kept current; newest first.

### 2026-07-06 (later) — memory-loop root cause + write-health detector
- **Every memory write is rejected by the server**: direct `POST /v1/feedback` returns
  HTTP 200 `accepted=false, record_id=null, warnings=["memory_write_failed"]`. The
  HTTP status is useless as a health signal — assert on the BODY.
- The binary knew and stayed silent: the rejection landed in `lastFeedbackError`,
  which no code read (write-only diagnostics). PR #84 surfaces it (TUI info line +
  `--mode json` `feedback_error` event).
- F12 now opens with a direct-API write-health probe and exits early on failure:
  fails in <1s at the true cause instead of ~5min/$0.60 at the basis=prior symptom.
- `memory_unavailable` on recommends is INTERMITTENT — its absence during one run must
  not be read as "recall healthy" (it briefly sent this investigation toward evidence
  thresholds).
- 5-agent code-trace of the server path (journal in the session workflow dir):
  `reinforced_entry_ids` echoes recommend-time recall neighbors, so `[]` during
  warm-up is expected and diagnostic of nothing; `MEMORY_WEIGHT_MIN=0.0` means ONE
  retrieved outcome flips basis to memory — no threshold story; lane/namespace
  computed once and reused on both paths — no scoping mismatch. The break is at the
  Minima↔Mubit ingest boundary (and the SDK treats a done-ingest-job with
  `writes[].success=false` as success — silent-failure hole worth a server PR).

### 2026-07-06 — v0.7.2 release compat + memory-loop status
- **Suite green on both binaries**: installed 0.7.1 and the v0.7.2 release asset
  (`BENCH_MINIMA_BIN=<path> bun bench/run.ts`). Version-tolerant assertions cover the
  0.7.2 renames: `· working`→`· running` (isIdle accepts both), denial copy
  ("Permission denied for X" → "The user declined the X call"), `/fork`+`/clone`
  honest copy, and models satisfying an "edit" ask with the new `apply_patch` tool.
- v0.7.2 plan-mode correctly blocks `apply_patch` (the #77 review fix) — verified live
  by F7 against the release binary.
- **Memory loop: partially restored, still not closing.** The v0.7.2 prod redeploy
  cleared the `memory_unavailable` recommend warning, but F12 still shows
  reinforced_entry_ids never echoing and same-task warm-namespace probes routing on
  `prior`. Needs server-side investigation of the feedback→Mubit write path; F12 is
  the standing detector. (Possible contributor: one outcome per task may be below the
  evidence threshold — a heavier warm phase, k=3 per task, is worth trying.)

### 2026-07-06 — Phase C (flow suite) findings
- **Child routing decisions DO persist correctly** — each sub-agent writes its own
  routing_decisions row with `agent_id = <childId>` demuxing it from the lead (verified
  live: 3 children with per-child tool_calls read/glob/bash + worktree isolation). Two
  false alarms on the way were both harness-side: the assert library's SELECT omitted
  agent_id, and rows become visible to external readers slightly after the lead's
  (write-queue flush lag) — poll with a grace window, never point-read.
- **The packages/tui test suite leaks git worktrees**: stale `/tmp/minima-wt-dirty-step-*`
  and `/tmp/minima-wt-wt-step-*` dirs from spawn tests predate bench runs. Flows must
  baseline `/tmp/minima-wt-*` pre-run and assert on the set DIFFERENCE; worth a small
  cleanup fix in the tui test suite.
- **In-cwd reads DO prompt** despite the `app.tsx:565` comment claiming "read/ls
  auto-allow within cwd" — `permissions.ts:41` starts `allowedDirs` empty and nothing
  pre-approves the cwd. Locked in by F7; either the comment or the behavior should change.
- **Overlay answering must be effect-keyed**: a single keypress can race the overlay
  lifecycle (deny → model instantly retries → new overlay paints inside the same poll
  window). F7's driver retries each answer key until its observable effect (deny text,
  disk change, transcript content) lands.
- **Idle detection that survives repaints**: compare `lastIndexOf("· ready")` vs
  `lastIndexOf("· working")` over the accumulated output — the last footer paint always
  reflects current state. Needed before typing after DB-predicate turn ends (the visible
  turn end precedes busy-clear by seconds; typed chars during the tail may not echo).
- **Prompt-dictated task-tool JSON is genuinely nondeterministic**: the model sometimes
  omits `isolation:"workdir"` even when asked; quoting the exact field name + a one-shot
  in-session retry makes F5 reliable. The ladder (F10), by contrast, is fully
  deterministic via the mock's recommendQueue + a present-but-invalid provider key.

### 2026-07-06 — Phase B (dataset) findings
- **Never `await` child stdout/stderr streams to completion after killing a process**:
  the agent's grandchildren (pytest, bun test) inherit the pipe and hold it open past
  the parent's death, hanging the collector indefinitely — this stalled the first
  calibration batch. `sh()` now awaits `proc.exited` and gives the streams a 2s grace
  race instead.
- **k=1 calibration is a smoke, not a label**: single-attempt solves by the cheap arm
  demoted ta-007 (with the audit's structural evidence agreeing) but cannot
  distinguish "cheap solves 100%" from "cheap solves 40% and got lucky" — medium bins
  especially need the full k=5 pass before routing accuracy is judged against them.
- **Pinned calibration runs never touch the Minima server** — `--model X` bypasses
  routing entirely, so difficulty calibration is pure provider spend with zero effect
  on the routing namespace. Exactly what we want: calibration cannot pollute the
  learning loop.
- **Cheat-guard needs an artifact filter**: running pytest inside the attempt drops
  `tests/__pycache__/*.pyc` as untracked files under `tests/`, which false-flagged the
  very first calibration attempt as test-tampering. The guard now ignores
  `__pycache__/.pyc/.pytest_cache/node_modules` before applying the tests/ rule.
- Headless agent runs on seeded tasks work exactly as designed: haiku found and fixed
  the `_example` seeded bug in ~23s for ~$0.01, graded by hidden tests post-hoc.
- Go is not installed on this machine → the plan's `go-tool` fixture became `js-lib`
  (zero-dep bun:test library, same fastest-suite role for future worktree/DAG flows).

### 2026-07-06 — findings from making the flows green

- **PRODUCT FINDING — offline turns bypass the budget ledger entirely.** An
  offline-fallback turn runs the default model (real provider spend, `actual_cost_usd`
  recorded on the decision row) but books NOTHING to the ledger: no reserve/reconcile
  events, `spent_usd` stays 0, and `--budget-enforce` cannot refuse it (the reserve path
  needs a positive server cost estimate; offline/pinned synthetic rows have est 0 and the
  reserve block is routing-gated in runtime.ts). Locked in as F1's `offline-budget
  lock-in` case — flips loudly if a fix lands. Follow-on: enforce-deny tests MUST route
  through a server (bench uses the mock) or a transient offline fallback silently
  neuters them.
- **TUI drops Enter while busy — including the invisible post-turn tail.** After the
  reply finishes streaming, judge + feedback + memory-write keep `busy` true for up to
  several seconds; during that window typed characters still echo into the input box but
  Enter is silently ignored (same `if (busy) return` guard family as the known abort bug
  #83). Naive scripted typing concatenates commands in the input box. Driver fix:
  `rig.submitUntil(text, effect)` — type once, then retry Enter until the command's
  unique effect appears (fresh response regex or DB predicate). A retried Enter is
  harmless (input is empty if the previous one submitted).
- **Accumulated-output matching must use UNIQUE expected strings.** Ink repaints the
  whole screen constantly, so previously-rendered content reappears after any
  `mark()` — a `since` offset does NOT protect against matching stale repaints.
  Assert on strings that appear exactly once per flow (include arguments/amounts:
  `Budget set: $0.02 (warn mode)`), and prefer DB predicates over screen text.
- **Live routing can transiently fall back offline** (cold-start recommend latency) even
  when api.minima.sh is healthy — never build a hard check on "this turn will be
  server-routed" unless the flow retries or uses the mock. F4 asserts all-turns-routed
  as a flow-level invariant and accepts the rerun cost.
- **Turn-end signal**: the `routing_decisions` row is the reliable "turn substantively
  done" oracle (WAL lets a readonly reader poll while the TUI writes), but it lands
  BEFORE busy clears — combine row-polling with submitUntil for the next input.
- Boot state: default model is `gpt-4o-mini` before any routing; readiness marker is
  the status-bar `· ready`; typing `/xyz` opens a commands suggestion box that does not
  interfere with Enter-submission of a fully-typed command; `/exit` exits 0; `/clear`
  clears only the transcript (locked in by F4: planted token still recalled after).
- `/budget set <tiny>` renders `$0.00` (`toFixed(2)`) — match `Budget set: \$0\.00` for
  sub-cent limits; the exhausted-refusal message is `budget exhausted: $X spent of $Y`.

### 2026-07-06 — Phase A bring-up
- **Bun 1.3.14 native PTY works** for driving the Ink TUI: `Bun.spawn(cmd, {terminal:
  {cols, rows, data(term, chunk){...}}})`; the data callback signature is
  `(Terminal, Buffer)`; write with `proc.terminal.write("...\r")`. No node-pty needed.
- **Keys resolve from the global config store** (`~/.minima-harness/config.env` +
  keychain) even in disposable cwds — that's what makes scratch-dir flows work with zero
  per-flow env setup. Repo `.env.harness` has the same key names if explicit env is wanted.
- **`/reconnect` re-reads `process.env.MINIMA_URL`** (`config.ts:75` — env wins over cfg).
  So the deterministic offline→online story is: launch with `MINIMA_URL=http://127.0.0.1:
  <port>` while nothing listens (offline fallback), start the mock server on that port,
  `/reconnect`. `--offline` itself is a one-way door (sets cfg.minimaUrl='' and no env var
  exists to restore) — never use it for reconnect flows.
- **`/budget set` preserves accumulated spend** (new ledger, same `session:<run_id>`
  scope, ON CONFLICT keeps `spent_usd`) and **preserves the current mode**. Deterministic
  enforce-refusal: spend under warn first, tighten the limit below observed spend, then
  `/budget mode enforce` — the next prompt is refused at the exhausted gate
  (`budget exhausted: $X spent of $Y`) *before any provider spend*, and no
  routing_decisions row is written for the refused prompt.
- **Smoke economics**: one routed trivial turn ≈ $0.004 (sonnet via prior basis, argmin).

### 2026-07-06 — from the research inventory (file:line ground truth)
- Do not script/demo: `/undo` (no-op `git checkout --`), `/fork`+`/clone` (stubs),
  `--thinking` (parsed, never applied), Ctrl+R confirm (cosmetic), Esc/Ctrl+C abort
  (dead code, task #83), `/tree` cost/status rows (stuck "running" — screenshot during
  run only), `save$` column (baselineModelId has no setter).
- `--mode json` events are lossy (no tool args / model / cost) → SQLite is the primary
  oracle; the JSON stream is asserted only as a frozen vocabulary contract.
- Headless `--print`/`--mode json`: single prompt per process, budget events on stderr,
  exit 1 on provider hard-failure/offline-empty, exit 2 on usage errors.
