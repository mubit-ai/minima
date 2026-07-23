# P1 — Output economics: artifact spill store (implementation plan)

> Planned 2026-07-23 against `feat/boosting` @ 49ef395, per `boosting-roadmap.md` §E and
> `wave2-preflight.md`. All paths below are relative to `packages/tui` unless noted.
> Branch/worktree: `feat/boost-p1-artifacts` / `minima-boost-p1-artifacts`.

## 1. Scope + non-goals

**Scope.** Wire an artifact store into the frozen seam's `SpillSink` (`src/tools/_bounds.ts`,
which already appends `; full output saved: <ref>` / `[full output saved: <ref>]` and sets
`spill_ref` in `boundDetails` — pinned by `tests/bounds.test.ts` B8, untouched here). Truncated
tool output is content-addressed to `~/.minima-harness/artifacts/<sha256>.txt` (sibling of the
DB, same home as the v13 `blobs/` tier), indexed in SQLite, and the truncation notice names an
absolute file path the model pages back via the normal `read` tool. Consumers: grep, glob, ls
(via `boundText` spill option) and bash (via a stream tee — see §Design). `read` gains an
artifact-root confinement allowance so sub-agents can page refs too.

**Non-goals.**
- GC/retention/quotas for the artifact dir — explicitly out; the index rows (`bytes`,
  `created`, `last_used`) exist so a later feature can add GC without a schema change.
- Spilling `read` output (read is already pageable by offset/limit) or write/edit/web tools.
- No seam change: `_bounds.ts` / `_rg.ts` stay byte-identical. No new tool params — the tool
  JSON-schema snapshot (`tests/__snapshots__/tool-schemas.test.ts.snap`) must not change.
- The v13 blob tier (`tool_calls.result_ref`, `BLOB_SPILL_BYTES`, `blobs/`) stays untouched —
  it is internal persistence; artifacts are the model-visible tier.
- No UI/TUI rendering work; the ref rides inside existing tool-result text.

## 2. Write-set (exhaustive)

**Created**
- `src/tools/_artifacts.ts` — `ArtifactStore` (+ `ArtifactStream`), the only new module.
- `tests/artifacts-spill.test.ts` — behavioral consumer tests (imports existing modules only).
- `tests/artifacts-store.test.ts` — store + DB index + migration tests.

**Modified**
- `src/tools/types.ts` — add `ToolArtifacts` interface; `FsToolOptions` gains optional
  `artifacts?: ToolArtifacts`.
- `src/tools/grep.ts` — thread `artifacts` into `executeWithin` (lines 52–56); add
  `spill: artifacts?.sink("grep") ?? null` to the `boundText` opts (lines 88–92). Nothing else.
- `src/tools/glob.ts` — same shape: `executeWithin` head (lines 60–64) + `boundText` opts
  (lines 91–95).
- `src/tools/ls.ts` — same shape: `executeWithin` head (lines 20–24) + `boundText` opts (line 56).
- `src/tools/bash.ts` — tee: optional `tee` callback in `pumpStream` (lines 31–47); stream
  setup beside the `BoundedBuffer` (~line 90); ref line on completion (lines 139–142) and on
  timeout/abort (lines 129–137).
- `src/tools/read.ts` — artifact-root allowance at the `resolveWithin` failure branch
  (lines 33–35); factory opts stay `FsToolOptions`.
- `src/tools/builtin.ts` — `BuiltinToolsOptions.artifacts?: ToolArtifacts`, passed into the
  shared `fs` object (line 63).
- `src/db/minima_db.ts` — ONE migration batch appended at the `MIGRATIONS` tail (after the v18
  batch closing at line 444); one new method `recordArtifact(...)` near `readBlob` (~line 1160).
- `src/minima/config.ts` — `artifacts: boolean` flag (interface near `memoryLedger` ~line 130,
  default in `harnessConfig()` ~line 195, env read in `configFromEnv()` ~line 233).
- `src/minima/spawn.ts` — `CreateSpawnOptions.artifacts?: ToolArtifacts` (lines 31–39); pass to
  `builtinTools` (line 121).
- `src/cli/main.ts` — construct the store when `config.artifacts` (near tool assembly ~line 670);
  extend `toolsFor` (lines 551–567) to accept/pass it; `store.attach(db, runId)` right after
  `agent.db = db; agent.runId = runId` (~line 807); pass `artifacts` into `createSpawn` (~line 924).
- `tests/config_env.test.ts` — flag default/opt-out coverage.

**Untouched by contract**: `src/tools/_bounds.ts`, `src/tools/_rg.ts`, `src/tools/_io.ts`,
`tests/__snapshots__/tool-schemas.test.ts.snap`, `package.json`/lockfile.

## 3. Design decisions (the three landmines, settled)

**Ref format.** `ref` = the absolute path of the artifact file:
`<artifactsDir>/<sha256-hex>.txt` where `artifactsDir = join(dirname(defaultDbPath()), "artifacts")`
(store disabled when `MINIMA_DB_PATH` is `:memory:`). An absolute path is directly consumable by
`read` with zero prompt guidance. Notice strings (model-visible, pinned):
- grep/glob/ls (seam-produced, already in `_bounds.ts`):
  `[output truncated: showing first 200 of 3187 matches]; full output saved: /abs/….txt`
- bash (bash-produced, mirrors the seam's null-notice format): a final line
  `[full output saved: /abs/….txt]` after `[exit N]`, or after the partial output on
  timeout/abort. `details.spill_ref` set in both cases.

**Bash (landmine 1).** `BoundedBuffer` discards the middle while streaming, so bash NEVER has
`full` — no `SpillSink` call, no seam change. Instead `bash.ts` tees: when artifacts are enabled,
`beginStream("bash")` opens `<artifactsDir>/tmp-<rand>.part` (`Bun.file(...).writer()`), and every
decoded chunk pushed into the buffer is also `stream.write(chunk)` + incremental
`Bun.CryptoHasher("sha256").update(chunk)` (file order = push order = what the model would have
seen, stdout/stderr interleaved). On completion: if `finish().truncated` (total > 50 000 chars),
`commit()` — end the sink, rename to `<sha>.txt` (dedupe: if target exists, delete tmp), write the
index row; else `discard()`. Timeout/abort: same rule against the buffer's running total. Every
store operation is fail-open (a tee error disables the spill for that call; the command result is
never affected).

**Read paging vs confinement (landmine 2).** Verified: the LEAD agent's tools are built with no
`workdir` base (`main.ts:557` passes none), so `resolveWithin` (src/tools/_io.ts:25–36) passes
absolute artifact paths through unchanged — lead-agent `read` pages refs TODAY with zero changes.
Sub-agents (`spawn.ts:121`) ARE confined, and `~/.minima-harness/artifacts` is outside any
workdir, so `read.ts` adds the explicit allowance: when `resolveWithin(path, opts.workdir)` fails
AND `opts.artifacts` is set, retry `resolveWithin(path, opts.artifacts.dir)`; only on that second
failure return the original escape error. `_io.ts` itself is untouched; the jail opens toward
exactly one root, only when the feature is on.

**P3 overlap (landmine 3).** P1's total footprint in the shared files: `grep.ts` = the
`executeWithin` parameter list + ONE added option in the `boundText` call (lines 88–92);
`read.ts` = the two-line resolve branch at the top of `execute` (lines 33–35). P1 does not touch
grep's body assembly (lines 93–99) or read's output formatting — the regions P3's snapshot
stamping will edit. Expected merge: trivial, same-function different-lines.

**Store module.** `src/tools/_artifacts.ts` exports:
- `interface ArtifactIndex { recordArtifact(r: {sha, path, runId, toolName, bytes, lineCount}): void }`
  (structural — the store never imports `MinimaDb`, matching the db layer's no-agent-imports style);
- `class ArtifactStore implements ToolArtifacts` — `constructor({dir})`, `attach(index, runId)`
  (late-bound, mirroring main.ts's `bookSearchFee` pattern since tools are built before the DB
  opens), `sink(tool): SpillSink` (hash → write-if-absent → index row → `{ref}`; any error →
  `null`, notice stays plain), `beginStream(tool)` for bash;
- `ToolArtifacts` (in `types.ts`): `{ dir: string; sink(tool): SpillSink; beginStream(tool): ArtifactStream | null }`.
Index rows are written via `MinimaDb.recordArtifact` (upsert on sha, bumps `last_used`) — state
in the DB; the context only ever carries the projection (the notice line).

## 4. Flag

- **Name**: `MINIMA_TUI_ARTIFACTS`. **Default ON**; opt-out `MINIMA_TUI_ARTIFACTS=0`.
- **Wiring**: `HarnessConfig.artifacts: boolean`, default `true` in `harnessConfig()`;
  `cfg.artifacts = process.env.MINIMA_TUI_ARTIFACTS !== "0"` in `configFromEnv()` — exactly the
  `bigPlan`/`memoryLedger` shape (config.ts:232–233). Not an `optInFlag` (it is default-on).
- **What is gated**: store construction in `main.ts` (flag off → no `ArtifactStore`, no
  `artifacts` option reaches any tool factory or `createSpawn`). Therefore gated: every notice
  suffix, every `[full output saved: …]` line, `details.spill_ref`, all artifact-dir writes, all
  index rows, and the read-tool allowance (inert when `opts.artifacts` is undefined). NOT gated:
  the migration batch (schema exists regardless — same policy as the `memories` table vs the
  `memoryLedger` flag).

## 5. Migration (expected integration position 19 — documentation only, never coded)

Append ONE batch at the END of `MIGRATIONS` (src/db/minima_db.ts, after the v18 batch):

```ts
// artifacts index — model-visible spill tier (P1). Files live beside the DB under
// artifacts/<sha256>.txt; rows are provenance + future-GC bookkeeping. run_id is a soft
// join key to runs(run_id) — deliberately no FK so this batch stays self-contained.
[
  `CREATE TABLE IF NOT EXISTS artifacts (
     sha        TEXT PRIMARY KEY,
     path       TEXT NOT NULL,
     run_id     TEXT,
     tool_name  TEXT,
     bytes      INTEGER NOT NULL,
     line_count INTEGER NOT NULL,
     created    REAL NOT NULL,
     last_used  REAL NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS ix_artifacts_run ON artifacts(run_id, created)",
],
```

- Idempotent/replay-safe: both statements are `CREATE … IF NOT EXISTS`, the exact class
  `reconcileSchema` (minima_db.ts:911–923) replays on every open. No `ALTER`, no `UPDATE`.
- **Existing tables touched: none.** Interacts (soft join key only, no constraint, no read at
  migration time) with `runs.run_id`. Commutes with any other appended batch (P4/P3) — the
  batch creates only its own objects. No version index appears anywhere in code or tests.

## 6. Acceptance criteria (each red on base @ 49ef395 → green on the branch)

Run in `packages/tui`. Red-proof per wave2-preflight §Verification: scratch worktree at
`origin/feat/boosting`, copy ONLY the two new test files, `bun install`, run the commands.

- **AC1 (roadmap placeholder criterion)** — a bash command producing ~1MB (20 000 unique lines
  via `awk`) yields a body ≤ ~51k chars containing head + tail + omission marker + `[exit 0]` +
  `[full output saved: <abs path>]`; the file exists under the test's artifact dir, has 20 000
  lines, and its name is the sha256 of its content.
  Verify: `bun test tests/artifacts-spill.test.ts -t "AC1"`.
  **RED is BEHAVIORAL**: the test hand-rolls an inline `artifacts` object (no new-module import);
  old `bashTool` ignores the unknown option (bun test does not typecheck), runs the real command,
  and the `[full output saved:` assertion fails against real output of the existing surface.
- **AC2** — `readTool({ workdir: <other tmp dir>, artifacts })` pages the AC1 ref hermetically:
  `{path: ref, offset: 9000, limit: 5}` returns exactly lines 9000–9004 with correct numbering.
  Verify: `bun test tests/artifacts-spill.test.ts -t "AC2"`.
  **RED is BEHAVIORAL against existing read**: current `read` answers
  `read: path escapes workdir (...)` — the confinement collision, asserted head-on.
- **AC3** — grep with 300 matches emits
  `[output truncated: showing first 200 of 300 matches]; full output saved: <ref>` and the ref
  file contains all 300 matches; glob (250 files) and ls (600 entries) equivalents.
  Verify: `bun test tests/artifacts-spill.test.ts -t "AC3"`. RED behavioral (notice lacks suffix).
- **AC4** — store semantics: content addressing dedupes (same text twice → same ref, one file,
  one upserted row with bumped `last_used`); `attach(db, runId)` lands a row queryable via
  `SELECT tool_name, bytes, line_count FROM artifacts WHERE sha = ?`; unattached store still
  writes the file (fail-open); stream write/commit/discard; fresh `MinimaDb` has the `artifacts`
  table (sqlite_master introspection, no version pin) and double-open replays cleanly.
  Verify: `bun test tests/artifacts-store.test.ts`. RED = missing module/table (declared weak
  evidence — AC1/AC2/AC3 carry the behavioral burden).
- **AC5** — flag: default config has `artifacts === true`; `MINIMA_TUI_ARTIFACTS=0` →
  `false`; and (in artifacts-spill) tools built WITHOUT the option produce byte-identical
  notices to today and write zero files.
  Verify: `bun test tests/config_env.test.ts -t "MINIMA_TUI_ARTIFACTS"` (red: property absent on
  the existing `configFromEnv()` surface) and `bun test tests/artifacts-spill.test.ts -t "AC5"`.
- **Gates** (all green before push): `bun test && bun run check && bun run lint`.
  `bun run check` also enforces the terminology guard over the implementation.

## 7. Test plan (all hermetic: mkdtemp + rm, no network, no model, no spend)

- **tests/artifacts-spill.test.ts** — imports ONLY shipped modules (`bashTool`, `grepTool`,
  `globTool`, `lsTool`, `readTool`) + an inline hand-rolled `ToolArtifacts` literal writing into a
  mkdtemp dir (keeps every test in this file runnable — and behaviorally red — on the base tree).
  Covers AC1 (bash 1MB tee), AC2 (read paging under confinement + allowance), AC3 (grep/glob/ls
  notice + spill file contents), AC5 off-parity, plus: bash timeout carries partial output AND the
  ref when >50k chars streamed; bash under-cap output leaves no artifact file (tmp discarded);
  spill sink throwing → notice stays plain, command result unaffected (fail-open).
- **tests/artifacts-store.test.ts** — imports `ArtifactStore` + `MinimaDb` (temp DB path).
  Covers AC4: content addressing, index upsert/provenance, unattached fail-open, stream
  write/commit/discard + dedupe-on-rename, migration introspection + replay (open→close→open),
  and `recordArtifact` idempotence.
- **tests/config_env.test.ts** (extended) — AC5 flag default/opt-out, using the file's existing
  env save/restore harness.

## 8. Manual-test scenario sketch (per acceptance criterion)

- **AC1**: in `minima`, prompt:
  `Run exactly this bash command: awk 'BEGIN { for (i=0;i<20000;i++) printf "line %06d abcdefghijklmnopqrstuvwxyz\n", i }'`
  Expect on screen: head lines, `[... N chars omitted ...]`, tail lines, `[exit 0]`,
  `[full output saved: /Users/<you>/.minima-harness/artifacts/<sha>.txt]`.
  Verify: `wc -l ~/.minima-harness/artifacts/<sha>.txt` → 20000, and
  `sqlite3 ~/.minima-harness/minima.db "SELECT tool_name, bytes, line_count FROM artifacts ORDER BY created DESC LIMIT 1;"`
  → `bash|~1MB|20000`.
- **AC2**: follow-up prompt: `Read lines 9000 to 9010 of that saved file.` Expect the model to
  call `read` on the ref path and show numbered lines `9000:`–`9010:` matching the awk output.
- **AC3**: prompt: `grep for "import" across this repo`. Expect the grep result to end with
  `…of N matches]; full output saved: <ref>`; spot-check the ref file holds matches beyond the
  200 shown (`sed -n '201,205p' <ref>`).
- **AC4**: `sqlite3 ~/.minima-harness/minima.db ".schema artifacts"` shows the table; repeat the
  AC1 command → same sha, `ls ~/.minima-harness/artifacts | wc -l` unchanged, `last_used` bumped.
- **AC5**: `MINIMA_TUI_ARTIFACTS=0 minima`, rerun the AC1 prompt. Expect the pre-P1 output (no
  saved-line), and `ls -la ~/.minima-harness/artifacts` gains no new file.

## 9. Integration notes (for the PR train — expected order P1 → P2 → P4 → P3)

- **grep.ts / read.ts (P1 ∩ P3)**: P1's exact regions are declared in §2/§3 — grep
  `executeWithin` head + one `boundText` option; read's two-line resolve branch. P3 should stamp
  in grep's body assembly (grep.ts:93–99) and read's output path — disjoint lines; semantic merge
  expected trivial. P3's plan must declare against THIS map.
- **minima_db.ts MIGRATIONS tail (P1 ∩ P3 ∩ P4)**: textual conflict only; the P1 batch touches no
  existing tables and commutes (§5). Re-order freely at integration; never pin indices.
- **config.ts / main.ts / spawn.ts**: additive option threading in all three; P2/P4 add sibling
  flags/options — union merges.
- **Schema snapshot**: P1 changes NO tool parameters and adds NO tools — assert at review that
  `tests/__snapshots__/tool-schemas.test.ts.snap` has zero diff. `details.spill_ref` is additive
  result metadata, not schema surface.
- **Seam freeze**: `_bounds.ts`/`_rg.ts` byte-identical (verify with
  `git diff origin/feat/boosting -- src/tools/_bounds.ts src/tools/_rg.ts` → empty). No signature
  changes anywhere; no orchestrator sign-off needed.
- Zero new deps; no code copied from oh-my-pi (reference doc consulted for shape only; the tee +
  content-addressed store are reimplementations against this repo's own v13 blob-tier precedent).
