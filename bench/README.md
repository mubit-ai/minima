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

## Running

```sh
bun bench/run.ts            # all flows
bun bench/run.ts f1 f9      # a subset
```

Live-lane cost: the full Phase A suite spends well under $0.10/run (trivial prompts,
mock server wherever determinism matters). Exit code is non-zero if any hard check fails;
per-flow transcripts land in `bench/artifacts/scratch/<flow>-<ts>/transcript.txt`.

Status (2026-07-06): **f1 30/30 · f9 11/11 · f4 16/16 — all PASS** against installed
0.7.1 + hosted api.minima.sh.

## Findings log

Datestamped facts discovered while building/running the flows — kept current; newest first.

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
