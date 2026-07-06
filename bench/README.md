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

Difficulty spread: 12 trivial / 7 easy / 12 medium / 2 hard. Two deliberate traps test
that routing keys on real difficulty rather than statement length/tone. Difficulty
labels are structural (diff footprint); `gen/calibrate.ts` measures empirical solve
rates per arm and `build_index.ts` folds them into `tasks.jsonl` — measured rates
override structural bins when they disagree. Precedent: ta-007 was authored hard
(cross-module diagnosis) but the cheap arm solved it first-try in 46s → demoted to
medium. Mini-calibration (k=1 smoke) so far: ka-001/pc-002/pc-004/ta-007 all solved by
haiku; the full k=5 cheap+frontier calibration over all 33 tasks is still pending and
is the authoritative labeling pass (~$10-20, ~330 attempts).

Anti-leakage: agents under test see ONLY the materialized template (+ seeded bug) and
the `problem_statement` — never `task.json` (whose `notes` describe the defect), never
`hidden_tests.patch`. Statements are symptoms-only for bugfixes (audited: no defect
file/function names, no fix quotes); feature statements specify routes/signatures.

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

Status (2026-07-06): **f1 30/30 · f9 11/11 · f4 16/16 — all PASS** against installed
0.7.1 + hosted api.minima.sh.

## Findings log

Datestamped facts discovered while building/running the flows — kept current; newest first.

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
