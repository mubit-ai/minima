# W4.1 — Background bash jobs (MUB-203) — Wave 4, merges 2nd (after typed-task)

> Plan pass 2026-07-24 against feat/boosting @ ba6eb32. Harness: `packages/tui`. Line numbers are anchors — re-verify at build time.
> Policy: zero new deps, reimplement-only, `_bounds.ts`/`_rg.ts` frozen, `_artifacts.ts` spill API consume-only, enforcement in harness code, state in the DB.
> **R2 RESULT: `loop.ts` is UNTOUCHED by this slice → TTSR takes the whole stream region, no partition needed.**

## Scope / Non-goals

**Scope.** Additive `background: true` on the `bash` tool: spawned exactly like today's foreground path (`Bun.spawn(["bash","-c",cmd], {detached:true})`, `bash.ts:100-111`) but returns a job handle in <1s instead of awaiting exit. New job-control tool `bgjob` (status / wait / output / kill / list). Output → per-job `BoundedBuffer` (50k head+tail, `_bounds.ts:192-253`) with the same P1 artifact tee bash uses (`bash.ts:117-129`, `ToolArtifacts.beginStream`, `types.ts:8-21`). Job rows persist in SQLite (`bg_jobs`, new v22 batch — the durable record surviving restart); live `Subprocess` handles in-memory in a new `BgJobRegistry`. Orphans reconciled + identity-verified-killed by a startup reaper at registry attach. Abort-tree: the composed per-call signal the loop already hands bash (`loop.ts:461`) kills that run's live jobs on Esc; session end kills all (recommended policy — Owner decision 1). All behind `MINIMA_TUI_BGJOBS` (default ON, `=0` opt-out); flag-off byte-identical.

**Non-goals.** No `loop.ts`/`state.ts`/`agent.ts` changes · no sub-agent bgjobs (`spawn.ts` untouched — D6) · no TUI job panel · no cross-session pipe re-attach (fds die with the old process; orphans are records + best-effort kills) · no changes to `_bounds.ts`/`_rg.ts`/`_artifacts.ts`/`check.ts` (`killProcessGroup` consumed as-is) · no incremental-output cursoring (`bgjob output` = current bounded snapshot; full output is the committed artifact) · no per-job wall-clock cap (`timeout` documented as ignored when `background:true`; kill is explicit / abort / session end).

## Write-set (exact)

| File | Change |
|---|---|
| `src/tools/_bgjobs.ts` | NEW — `BgJobRegistry` (launch/status/wait/output/kill/list, in-memory handles, per-job BoundedBuffer + artifact tee, exit continuation), structural `BgJobSql` seam (mirrors `ArtifactSql`, `_artifact_gc.ts:15-18`), `attach(dbLike, runId)` late-bind + startup reaper `reapOrphans`, `shutdown()`, `BgJobRow`, injectable probes (`processAlive`, `commandOf`, `harnessPid`) |
| `src/tools/bgjob.ts` | NEW — `bgJobTool(registry)` |
| `src/tools/bash.ts` | MOD — build `parameters` per-factory: registry present → add `background` bool prop; absent → today's exact schema (byte-identical). `execute` gains the launch branch (reuse workdir validation lines 83-98, then `registry.launch(...)`, return <1s) |
| `src/tools/types.ts` | MOD — `FsToolOptions.bgJobs?: BgJobRegistry` (additive, like `artifacts`/`seen`) |
| `src/tools/builtin.ts` | MOD — `BuiltinToolsOptions.bgJobs?`; thread into `bashTool`; conditionally append `bgJobTool(opts.bgJobs)` |
| `src/tools/index.ts` | MOD — export `bgJobTool` + `BgJobRegistry` |
| `src/minima/config.ts` | MOD — `bgJobs: boolean` on `HarnessConfig` (doc-comment by `artifacts`), default `true` in `harnessConfig()`, `cfg.bgJobs = process.env.MINIMA_TUI_BGJOBS !== "0";` in the default-ON cluster |
| `src/db/minima_db.ts` | MOD — ONE idempotent batch appended at the END of `MIGRATIONS` (after `seen_lines`, before line 494). Nothing else |
| `src/cli/main.ts` | MOD — 4 hunks: registry construction next to `artifactStore` (~682-689); `toolsFor` signature + call (~557-577 / ~696-703); `bgJobRegistry?.attach(db, runId)` next to `artifactStore?.attach` (~844); `bgJobRegistry?.shutdown()` as first line of `closeDb` (~924) |
| `tests/bgjobs-schema.test.ts` | NEW — imports EXISTING modules only (behavioral reds: migration presence, config flag default, flag-off byte-identity) |
| `tests/bgjobs.test.ts` | NEW — lifecycle: <1s handle, poll, wait, kill (group), abort-kill, bounded output + spill, job cap |
| `tests/bgjobs-reap.test.ts` | NEW — simulated-restart orphan reap (temp-file DB, two registry generations, injected probes) |
| `tests/config_env.test.ts` | MOD — one `MINIMA_TUI_BGJOBS` test |
| `tests/tool-schemas.test.ts` | MOD — pin bgjobs-enabled variants (inert `new BgJobRegistry()`): `bashTool({bgJobs})` under a distinct name + `bgJobTool`. Default roster/`bash` untouched |
| `tests/__snapshots__/tool-schemas.test.ts.snap` | REGENERATED (deliberate, never hand-edited) — additive only |

NOT modified: `loop.ts`, `state.ts`, `agent.ts`, `spawn.ts`, `_bounds.ts`, `_artifacts.ts`, `_artifact_gc.ts`, `check.ts`, `sink.ts`, `package.json`.

## Flag: `MINIMA_TUI_BGJOBS`, default ON, `=0` opt-out

Field `bgJobs`, `!== "0"` shape (mirrors `artifacts`/`memoryLedger`; not `optInFlag` which is default-off only). Flag-off byte-identity: no registry constructed → `builtinTools` gets `bgJobs: undefined` → `bashTool` emits today's exact schema, no `bgjob` tool. `toolSchemaHash` changes only when the flag is ON (deliberate; resume shows the warn-only tooling-mismatch notice once).

## Migration: ONE batch (v22 reserved), `bg_jobs` only

Appended at end of `MIGRATIONS` (after `seen_lines`), no hardcoded version index (tests introspect `sqlite_master`), replay-safe (`CREATE ... IF NOT EXISTS`).
```sql
CREATE TABLE IF NOT EXISTS bg_jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT,
  pid INTEGER, pgid INTEGER, harness_pid INTEGER,
  command TEXT NOT NULL, cwd TEXT,
  state TEXT NOT NULL,          -- running|exited|killed|orphaned|lost
  exit_code INTEGER, output_chars INTEGER, truncated INTEGER, spill_ref TEXT,
  started REAL NOT NULL, ended REAL, updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bg_jobs_run ON bg_jobs(run_id, started);
CREATE INDEX IF NOT EXISTS ix_bg_jobs_state ON bg_jobs(state);
```
**Tables touched: `bg_jobs` ONLY** (no ALTERs, no existing table touched) → commutes with any other Wave-4 batch. run_id soft-joins runs(run_id), no FK (self-contained, artifacts/seen_lines precedent).

## Design (load-bearing)

- **D1 Identity + registry.** Job id `bg_`+8 hex. DB row = the record (inserted `running` at launch; updated on exit/kill). In-memory `BgJobEntry` holds `Subprocess`, `BoundedBuffer`, live `ArtifactStream`, pump + `exited` promises. DB writes fail-open (`recordArtifact` stance). `BgJobSql` structural seam (`{run,query}`, satisfied by MinimaDb's public `db`) so `_bgjobs.ts` never imports `MinimaDb`. `attach(db, runId)` late-binds like `ArtifactStore.attach` (wired main.ts ~844) + runs the reaper.
  - **Orphan detection + PID-reuse hazard.** At attach, select `state='running'` rows with `run_id != current`. Three guards before any signal: (1) `harness_pid` liveness `process.kill(pid,0)` — alive → CONCURRENT session on the shared DB, skip; (2) job-group liveness `process.kill(-pgid,0)` — ESRCH → died with its session, mark `lost` (never invent an exit code); (3) identity `Bun.spawnSync(["ps","-p",pid,"-o","command="])` must contain the recorded `command` → match = true orphan → `killProcessGroup` + `orphaned`; mismatch = PID reused → NEVER signal, mark `lost`. Probes injectable for hermetic restart tests.
  - State machine `running → exited|killed|orphaned|lost`, terminal never regresses (guarded UPDATE `WHERE state='running'`). Cap: ≤16 concurrently `running` per registry; #17 → `errorResult` (feeds A3 anti-spiral).
- **D2 Output.** One `BoundedBuffer({maxChars:50_000, headChars:10_000})` per job fed by the same pump logic (reimplemented in `_bgjobs.ts` — 20 lines, avoids changing bash's public surface) + artifact tee `artifacts?.beginStream("bash")`. On exit: `buffer.finish()`; truncated → `commit()` + store `spill_ref`, else `discard()` (bash's exact rule). **W3.3 GC interplay is free**: the store records under the CURRENT run + `claimArtifact`s it, and `pruneArtifacts` exempts `protectRunId` rows → a live job's spilled log can't be pruned mid-session. `bgjob output` = `buffer.snapshot()` (bounded + omission marker).
- **D3 Tool surface (additive).** `bash` gains one optional `background` bool ONLY when a registry is wired (else byte-identical). Launch result <1s: `[background job bg_xxxxxxxx started (pid NNNN)] Poll with bgjob.`, `details:{job_id,pid,background:true}`. `bgjob` = one tool, `action` enum `["status","wait","output","kill","list"]` (smallest additive surface; **Owner decision 2**), `id` required except for `list` (custom validate wrapper, `rewindParameters` precedent), `wait` `timeout` default 30000 clamped [50,300000] via `Promise.race`. `kill` → `killProcessGroup` (SIGTERM, SIGKILL after 5s). Snapshot regen deliberate.
- **D4 Abort (traced).** Background launch returns immediately so the signal race is useless after return — instead the launch path registers `signal.addEventListener("abort", () => registry.kill(id,"aborted"))` (removed when settled). Net: Esc during the launching run kills that job's whole process group; a job outliving its prompt is killed only by `bgjob kill` / session end / next reaper. Kill always targets `-pgid` (detached spawn makes the leader its own group). **Owner decision 3.**
- **D5 Orphan policy** → Owner decision 1. Plan implements (a): `registry.shutdown()` as first line of `closeDb` (the single choke point every exit funnels through) = `killProcessGroup` each live job + mark `killed`; TERM-ignoring survivors caught by the next reaper.
- **D6 Sub-agents: NO bgjobs.** `spawn.ts` untouched (`builtinTools({workdir, exclude:["task"], artifacts})` never passes `bgJobs`). Justified: children bounded by effort wall-clocks + aborted at completion; a job outliving a child has no poller and can't reach the parent context. `agent_id` on the table lets a future slice enable it without a migration.
- **D7** No system-prompt/steering changes; a backgrounded `cat`/`grep` is still steered (steering runs `beforeToolCall`, upstream of execute).

## loop.ts declaration — UNTOUCHED (R2)

Zero hunks in `src/agent/loop.ts`. Lifecycle lives in `bash.ts` + `_bgjobs.ts` + `bgjob.ts` + `main.ts`. Both loop regions (W4.2's stream ~94-134 and dispatch ~142-167) byte-identical; the abort tree is reached through the signal the loop already passes every tool (`loop.ts:461`). **W4.2 (TTSR) claims its region with no partition negotiation.**

## Acceptance criteria (red→green, from `packages/tui`; V3 = new test files on scratch base)

1. **AC1 handle <1s, behavioral red.** `bun test tests/bgjobs-schema.test.ts -t "AC1"` — build `builtinTools()`'s `bash` (existing surface), validate `{command:"sleep 30; echo late", background:true, timeout:2000}` (unknown prop dropped by `objectSchema.validate` today), execute, assert wall-time <1500ms AND `details.job_id` defined AND `details.background===true` — RED today (call blocks ~2s to timeout, no job_id), green after (schema-test variant uses a real registry).
2. **AC2 migration present.** `-t "AC2"` — `new MinimaDb(":memory:")`; `sqlite_master` has `bg_jobs`; columns via `PRAGMA table_info`. No version number. Red→green.
3. **AC3 flag default + off byte-identity.** `-t "AC3"` — `configFromEnv().bgJobs===true` (red: undefined); `=0` → false; `bashTool().parameters.jsonSchema` has no `background` + `builtinTools()` has no `bgjob` (pin).
4. **AC4 pollable + killable, group kill.** `bun test tests/bgjobs.test.ts -t "AC4"` — bg `sleep 30 & echo $! > pidfile; wait`; status→running; kill→grandchild PID dies <4s (bash-group.test.ts probe); row `killed`.
5. **AC5 output bounded + spilled + GC-claimed.** `-t "AC5"` — >50k producer in bg; mid-run `bgjob output` <60k with omission marker; after wait `spill_ref` set, full content on disk, artifacts row carries current `run_id` (W3.3 exemption).
6. **AC6 abort kills the job.** `-t "AC6"` — launch with a signal; `abort()` after handle returns; group dead <4s; row `killed`.
7. **AC7 orphan reaped after simulated restart.** `bun test tests/bgjobs-reap.test.ts` — temp-file DB; gen-1 (injected dead `harnessPid`) launches `sleep 30`; drop without shutdown; reopen + attach gen-2 under a new run: identity-matched → killed + `orphaned`; pid-reused (injected different `commandOf`) → `lost`, ZERO kills (spy); live `harnessPid` row → untouched (concurrent-session guard).
8. **AC8 snapshot additive.** `bun test tests/tool-schemas.test.ts` — default roster + default `bash` byte-identical; two new entries (bgjobs-on `bash`, `bgjob`).

Full gates: `bun test && bun run check && bun run lint`, plus `MINIMA_TUI_BGJOBS=0 bun test` green.

## Test plan (hermetic)

No real servers/providers (tools exercised directly — loop untouched); sleeps ≤30s only as "longer than the window" anchors, kills end them in ms; temp dirs `mkdtempSync`+`afterEach` rm; DBs `:memory:` or temp files. AC5 uses a real `ArtifactStore` on a temp dir attached to `:memory:` MinimaDb (artifacts-spill recipe). Reap tests inject probes (identity-match branch uses real `ps` against the live `sleep`, verifying the probe on darwin/Linux CI). `config_env.test.ts` gains the `withEnv` triplet. Wall-clock margins generous (<1500ms for "<1s").

## Collision declarations

- `loop.ts`/`state.ts`: **untouched** (W4.2 unblocked).
- `config.ts`: 3 point insertions (field + default + env parse), textual-merge with any W4 flag.
- `main.ts`: 4 hunks (registry construct ~689; `toolsFor` 7th optional param + call ~557-577/~696-703; `attach` ~844; `shutdown` in `closeDb` ~924). Disjoint from typed-task's ~968-974 taskTool region. typed-task merges FIRST → bgjobs rebases over it.
- `builtin.ts`: one optional field + two lines. `types.ts`: one optional field. `index.ts`: one export block.
- `minima_db.ts`: ONE append-only batch (v22).
- Snapshot: additive entries only, regenerate on merge-train conflict (never hand-merge) — shared with typed-task's D1 task-tool pin; typed-task first, bgjobs regenerates over it.

## Owner decisions surfaced (→ checkpoint)

1. **Orphan policy (the flagged O1 decision).** (a) **KILL all live jobs at session end** (via `closeDb`→`shutdown()`; reaper handles crash leftovers only) — RECOMMENDED. Rationale: job stdout/stderr are pipes into the harness process; after harness exit nobody drains them → a chatty survivor blocks on a full pipe or dies of SIGPIPE, so "survival" is mostly illusory; the documented escape hatch is the same one foreground bash honors (`nohup … & disown` with redirected stdio survives deliberately). (b) LEAVE running, reap records next startup — user-started services survive, but dead-pipe blocking + unobservable orphans + riskier later PID-reuse judgments. **Recommendation: (a).**
2. **`bgjob` roster shape** — one tool with an `action` enum (planned, smallest additive surface) vs separate `bash_output`/`kill_shell` tools. **Recommendation: single tool.**
3. **Esc semantics** — Esc kills jobs launched under that run's signal (spec: "session abort kills jobs") vs Esc spares bg jobs (only session end kills). **Recommendation: Esc kills** (two-line change either way).
