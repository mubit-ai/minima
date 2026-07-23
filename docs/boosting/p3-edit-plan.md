# P3 — Edit engine: snapshot tags + seen-lines ledger + stale-edit guard (implementation plan)

> Planned 2026-07-23 against `feat/boosting` @ 49ef395, per `boosting-roadmap.md` §E and
> `wave2-preflight.md`. All paths relative to `packages/tui` unless noted.
> Branch/worktree: `feat/boost-p3-edit` / `minima-boost-p3-edit`.
> Collision surfaces declared against `docs/boosting/p1-artifacts-plan.md` §3/§9 (see §8).

## 1. Scope + non-goals

**Scope.** Every `read` and `grep` result is stamped with a short content-hash snapshot tag
(projection); the evidence behind it — which lines of which file at which content hash the
model has actually seen this session — is recorded in a SQLite seen-lines ledger (state).
`edit` verifies its target against that ledger at execute time: edits against a file changed
since it was read, or against lines the session never saw, are REJECTED with a deterministic
"re-read these ranges" recovery message. `write` records evidence silently (a file the model
just wrote is fully seen). A hermetic scripted benchmark (`tests/edit-bench.test.ts`) proves
zero regression on legitimate edits and 100% rejection of deliberately-stale ones, and runs
as a normal `bun test` gate. Enforcement is harness code inside `edit.ts` execute — chosen
over a `beforeToolCall` hook because the hook sees raw args and cannot resolve `path`
against the tool instance's per-sub-agent `workdir`; `_io.resolveWithin` semantics must
match exactly or the guard checks the wrong file. Never prompt text.

**Non-goals (explicit).**
- `write.ts` is NOT guarded (whole-file replacement has a different risk profile; it only
  *records* evidence). `apply_patch.ts` is fully out of scope — neither guarded nor
  recording; an apply_patch-then-edit sequence yields one stale rejection + re-read, which
  is acceptable recovery. Revisit both in a follow-up if the benchmark motivates it.
- Sub-agent coverage: `spawn.ts` untouched; only the lead agent's toolset gets the ledger.
  Sub-agent edits still mutate files → the lead's guard correctly rejects until re-read.
  The schema carries a nullable `agent_id` (always NULL in v1) so per-agent scoping needs
  no future migration.
- Ledger pruning/rollup across sessions: out. Rows are keyed by `run_id`; within a run,
  supersede-on-new-hash (§4 design) keeps per-file rows bounded. Cross-run GC is a later
  cleanup, no schema change needed.
- No tree-sitter, no syntax awareness, no new deps, no code copied from oh-my-pi
  (`docs/boosting/research/oh-my-pi-analysis.md` consulted for shape only).
- No new tool params; `tests/__snapshots__/tool-schemas.test.ts.snap` must show ZERO diff.

## 2. Write-set (exhaustive)

**Created**
- `src/tools/_seen.ts` — the only new module: `SeenLedger` class, structural `SeenIndex`
  interface (never imports `MinimaDb`), verdict logic, range coalescing/shifting,
  `sha256Hex`/`hashFile` helpers, pinned rejection-message builder.
- `tests/edit-guard.test.ts` — behavioral guard/stamp tests (AC1–AC4; imports only shipped
  tool modules + an inline hand-rolled ledger so every test runs — and reds — on base).
- `tests/seen-ledger.test.ts` — ledger module + DB index + migration tests (AC5).
- `tests/edit-bench.test.ts` — the rollout-gating benchmark (AC7).

**Modified**
- `src/tools/types.ts` — `FsToolOptions` gains optional `seen?: SeenLedger` (type-only
  import), beside P1's `artifacts?`.
- `src/tools/_io.ts` — `readLines` gains optional `opts.hasher?: (chunk: Uint8Array) => void`
  (called on each raw chunk pre-decode; single-pass hashing, file is already fully streamed)
  and the return gains `eof: boolean` (false only on the 100MB stop). Additive; existing
  callers destructure `{ body, n }` unchanged.
- `src/tools/read.ts` — stamp + record in `execute` (lines 50–54 today).
- `src/tools/grep.ts` — stamp + record in the body-assembly region (lines 93–99 today);
  `seen` threaded through `executeWithin` (lines 52–56) and the factory (lines 102–112).
- `src/tools/edit.ts` — the guard inside `execute` (lines 30–54 today) + ledger refresh on
  success.
- `src/tools/write.ts` — silent full-range evidence record after `writeText` (lines 30–34).
- `src/tools/builtin.ts` — `BuiltinToolsOptions.seen?: SeenLedger`; added to the shared `fs`
  object (line 63).
- `src/db/minima_db.ts` — ONE migration batch appended at the `MIGRATIONS` tail (after the
  v18 batch closing at line 444); three thin methods (`listSeenLines`, `replaceSeenLines`,
  plus the internal delete they share) appended near the blob-tier methods (~line 1160).
- `src/minima/config.ts` — `editGuard: boolean` (interface near `memoryLedger` ~line 130,
  default `true` in `harnessConfig()` ~line 195, env read in `configFromEnv()` ~line 233).
- `src/cli/main.ts` — construct `SeenLedger` when `config.editGuard` (tool assembly,
  ~line 670); pass through `toolsFor` (lines 551–567) into `builtinTools`;
  `ledger.attach(db, runId)` immediately after `agent.db = db; agent.runId = runId`
  (lines 806–807, same late-bind pattern as P1's store / `bookSearchFee`).
- `tests/config_env.test.ts` — flag default/opt-out coverage (AC6).

**Untouched by contract**: `src/tools/_bounds.ts`, `src/tools/_rg.ts`, `src/tools/apply_patch.ts`,
`src/minima/spawn.ts`, `src/agent/agent.ts`, `src/agent/loop.ts`,
`tests/__snapshots__/tool-schemas.test.ts.snap`, `package.json`/lockfile.

## 3. Flag

- **Name**: `MINIMA_TUI_EDIT_GUARD`. **Default ON**; opt-out `MINIMA_TUI_EDIT_GUARD=0`.
- **Wiring**: `HarnessConfig.editGuard: boolean`, default `true`;
  `cfg.editGuard = process.env.MINIMA_TUI_EDIT_GUARD !== "0"` in `configFromEnv()` — the
  exact `bigPlan`/`memoryLedger` shape (config.ts:232–233). Not an `optInFlag` (default-on).
- **What is gated**: `SeenLedger` construction in `main.ts`. Flag off → no `seen` option
  reaches any tool factory → zero stamps, zero ledger rows, zero rejections, byte-identical
  tool output to today. Stamping and rejection are gated TOGETHER (one construction site,
  one flag; a stamp with no ledger behind it would be a projection of nothing). Additionally
  the ledger is fail-open: unattached (no DB, `:memory:`, or any internal error) → `enabled`
  is false → tools behave exactly as flag-off. **NOT gated**: the migration batch — schema
  exists regardless (same policy as `memories` vs `memoryLedger`, and P1's artifacts table).

## 4. Snapshot tag, ledger record, and the migration

**Tag format (projection, token-minimal).** `snap = first 8 hex chars of sha256(raw file bytes)`.
- `read`: ONE trailing body line `[snap:1b9e02aa]` (~15 chars). The window is already visible
  via the body's line numbers; the path via the call args — nothing else is repeated.
  Omitted when the scan stopped early (`eof === false`), on error paths, and when disabled.
- `grep`: ONE trailing body line `[snap:9f3e21ab 7 files]` — aggregate hash = first 8 hex of
  sha256 over the sorted `<abs path>:<file sha256>\n` pairs of the files actually hashed;
  count = those files. Per-file hashes live only in the DB (state in DB, projection in
  context). Files are parsed from the SHOWN matches (`^(.+?):(\d+):` on `b.body` lines,
  absolute because the search path is absolute); caps: ≤ 50 distinct files, ≤ 4 MB each
  (stat first); over-cap or unparseable → silently skipped (no row, excluded from count).
  Zero hashed files → no tag. Ordering after P1 merges: matches → truncation notice (with
  P1's spill suffix) → exit-2 note → snap tag LAST.
- `edit`/`write`: output text unchanged (record silently; no tag).

**Ledger record.** One row per seen range: `(run_id, agent_id=NULL, path abs, start_line,
end_line 1-based inclusive, file_hash full sha256 hex, tool read|grep|write|edit, created)`.
- `read` records `[offset, offset+n-1]` (post-cap `n` — only lines actually shown); `n=0`
  records `[1,1]` (evidence of having seen the empty state).
- `grep` records each shown match line, coalesced per file (adjacent/overlapping merged).
- `write` records `[1, lineCount]` with the hash of the written bytes.
- `edit` success refreshes: new file hash; prior ranges shifted by the line delta
  (`SeenLedger.applyEdit` — ranges above the span keep, below shift by
  `newLines - oldLines` cumulatively per occurrence, the replaced span(s) recorded as seen).
- **Supersede-on-new-hash**: recording evidence with hash H for `(run, agent, path)` deletes
  that key's rows with hash ≠ H, then writes the coalesced union of surviving + new ranges —
  bounds volume to O(distinct fresh ranges per file) even in long sessions.

**Migration** (expected integration position 20 per wave2-preflight — P4 ships no batch;
locally lands at 19 — never coded, tests introspect `sqlite_master`, no version index
anywhere):

```ts
// seen-lines ledger (P3 edit guard) — per-run read/grep/write/edit evidence: which lines
// of which file, at which content hash, this session has actually seen. State here;
// the context only carries the [snap:…] projection. run_id soft-joins runs(run_id)
// (no FK — batch stays self-contained); agent_id reserved for sub-agent scoping (NULL in v1).
[
  `CREATE TABLE IF NOT EXISTS seen_lines (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id     TEXT NOT NULL,
     agent_id   TEXT,
     path       TEXT NOT NULL,
     start_line INTEGER NOT NULL,
     end_line   INTEGER NOT NULL,
     file_hash  TEXT NOT NULL,
     tool       TEXT NOT NULL,
     created    REAL NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS ix_seen_lines_key ON seen_lines(run_id, path, created)",
],
```

Both statements `CREATE … IF NOT EXISTS` — the exact class `reconcileSchema`
(minima_db.ts:911–923) replays idempotently on every open. **Existing tables touched: none.**
Interacts (soft join key only) with `runs.run_id`. Commutes with P1's `artifacts` batch —
it creates only its own objects.

## 5. The guard: staleness definition, verdict matrix, message formats

`hash_now` = sha256 of the raw bytes `edit` just read (it switches from
`readFile(p, "utf8")` to `readFile(p)` → hash the Buffer, then `toString("utf8")` — one
read, byte-consistent with the read/grep hashing). Evaluation order inside `execute`:
resolve → exists → read+hash → **stale check** → base not-found/ambiguity errors →
**unseen check** → write + ledger refresh.

| # | Situation | Verdict |
|---|---|---|
| 1 | Flag off / ledger unattached / any ledger error | ALLOW (fail-open, byte-identical to today) |
| 2 | File does not exist | defer to base `edit: no such file` |
| 3 | Ledger rows exist, `hash_now ≠` recorded hash (file changed by user, git, bash, another agent, apply_patch) | **REJECT stale** — regardless of whether old_string matches; recovery names the previously-seen ranges (now untrustworthy) |
| 4 | Rows exist, hash equal, old_string not found / ambiguous without replace_all | defer to base errors (guard silent — those messages are the actionable ones) |
| 5 | Rows exist, hash equal, EVERY occurrence span intersects a seen range | **ALLOW** (intersection, not containment: exact-string match is already a strong check; requiring full containment would false-reject grep-then-edit with context lines, destroying usability) |
| 6 | Rows exist, hash equal, some occurrence span disjoint from all seen ranges | **REJECT unseen** — names exactly the disjoint spans |
| 7 | NO rows for (run, path), old_string found | **REJECT unseen** — span = located occurrence(s) |
| 8 | NO rows, old_string not found | defer to base `old_string not found` |
| 9 | File created via `write` this session, unmodified since | ALLOW (write recorded full range → case 5) |
| 10 | File edited via `edit` this session, unmodified since | ALLOW (success refreshed hash + shifted ranges → case 5) |
| 11 | File externally rewritten with IDENTICAL bytes (touch, git checkout same content) | ALLOW (hash equal — content, not mtime, defines staleness) |
| 12 | Model mutated the file via its own bash (`sed -i`, scripts) | case 3 → REJECT stale (intended: re-read after out-of-band mutation) |

**Rejection messages (pinned, model-visible; ranges capped at 5 in text, `+N more` beyond;
full list in `details.reread`):**

```
edit: stale file: <abs path> changed since it was read (snap <old8> -> <new8>). re-read these ranges: <abs path>:<s>-<e>, <abs path>:<s>-<e> then retry the edit.
edit: unread lines in <abs path>: this session has no read evidence covering the target. re-read these ranges: <abs path>:<s>-<e> then retry the edit.
```

Returned via `errorResult(...)` with additive
`details: { error: true, edit_guard: "stale" | "unseen", reread: ["<path>:<s>-<e>", …] }`.
**Recovery path**: the model calls `read` on the named ranges → read stamps + records fresh
evidence under the new hash (superseding the stale rows) → the retried edit hashes equal and
intersects → proceeds. No prompt text anywhere; the message IS the tool result.

## 6. Acceptance criteria (each red on base @ 49ef395 → green on the branch)

Run in `packages/tui`. Red-proof per wave2-preflight §Verification: scratch worktree at
`origin/feat/boosting`, copy ONLY the new test files, `bun install`, run the commands.

- **AC1 (roadmap placeholder criterion)** — read a fixture file through `readTool` wired to
  a ledger, mutate it out-of-band, then `editTool` with a previously-valid old_string:
  result body matches `/^edit: stale file: .*re-read these ranges: .*:\d+-\d+/` and
  `details.edit_guard === "stale"`; the file on disk is UNCHANGED by the rejected call.
  Verify: `bun test tests/edit-guard.test.ts -t "AC1"`.
  **RED is BEHAVIORAL**: the test hand-rolls an inline `seen` object (no new-module import);
  base `editTool` ignores the unknown option (bun test does not typecheck), APPLIES the edit,
  and both the message assertion and the file-unchanged assertion fail against the existing
  surface.
- **AC2** — `readTool` output ends with `[snap:<8 hex>]` matching the first 8 of the file's
  sha256; the recorded evidence (via the inline ledger) is `[offset, offset+n-1]` + full hash.
  Verify: `bun test tests/edit-guard.test.ts -t "AC2"`. RED behavioral: base read body has no
  `[snap:` line.
- **AC3** — grep over a 3-file fixture emits the aggregate `[snap:<8 hex> 3 files]` tag, and
  a follow-up edit whose old_string is a matched line (+1 context line) is ALLOWED with no
  prior full read (intersection rule). Verify: `bun test tests/edit-guard.test.ts -t "AC3"`.
  RED behavioral: base grep body lacks the tag line.
- **AC4** — full recovery loop, scripted: reject (AC1 setup) → re-read exactly the ranges
  named in `details.reread` → retry the same edit → succeeds; final file content equals the
  expected post-edit text. Verify: `bun test tests/edit-guard.test.ts -t "AC4"`.
  RED behavioral: on base the FIRST edit succeeds where the script asserts rejection.
- **AC5** — ledger + DB semantics: `replaceSeenLines` supersedes rows with a different hash
  and coalesces ranges; `applyEdit` shifts ranges below a multi-line replacement by the line
  delta; fresh `MinimaDb` has `seen_lines` (sqlite_master introspection, NO version pin);
  open→close→open replays cleanly; unattached ledger is fail-open (verdict ALLOW, no stamp).
  Verify: `bun test tests/seen-ledger.test.ts`. RED = missing module/table — declared weak
  evidence; AC1–AC4 + AC7 carry the behavioral burden.
- **AC6** — flag: default `configFromEnv().editGuard === true`; `MINIMA_TUI_EDIT_GUARD=0` →
  `false`. Verify: `bun test tests/config_env.test.ts -t "MINIMA_TUI_EDIT_GUARD"` (red:
  property absent on the existing surface). Off-parity (tools without the option produce
  byte-identical output) is asserted inside edit-guard.test.ts ("AC6 parity").
- **AC7 (benchmark, no-regression gate)** — `bun test tests/edit-bench.test.ts`.
  **Thresholds (hard assertions, not logs)**: legitimate scenarios 12/12 succeed with the
  guard ON **and** 12/12 with it OFF (before/after parity — zero regression, precision 1.0:
  zero false rejections); stale scenarios 4/4 rejected ON with `/re-read these ranges:/`
  (recall 1.0) while 4/4 silently apply OFF (documents the gap being closed); recovery
  scenario ends with exact expected file content. RED behavioral on base: the four
  "ON rejects" assertions fail because the edits apply.
- **Gates**: `bun test && bun run check && bun run lint` all green before push
  (`bun run check` includes `scripts/check-terminology.ts` — no banned phrasing in any new
  code or tests).

## 7. Test plan (all hermetic: mkdtemp + rm, temp `MinimaDb` paths, no network, no model)

- **tests/edit-guard.test.ts** — imports ONLY shipped modules (`readTool`, `grepTool`,
  `editTool`, `writeTool`) + an inline hand-rolled ledger literal (base-runnable → behavioral
  red). Covers AC1–AC4, AC6 parity, plus the FULL verdict matrix of §5 (one test per row
  1–12, titled `matrix-<n>`), message-format pins (range cap `+N more`), CRLF byte-hash
  consistency, replace_all with a disjoint occurrence → unseen rejection naming that span.
- **tests/seen-ledger.test.ts** — imports `SeenLedger` + `MinimaDb`. Covers AC5: supersede/
  coalesce, `applyEdit` shifting (single + multi-occurrence, negative/positive deltas),
  `hashFile` size cap, migration introspection + double-open replay, fail-open paths.
- **tests/edit-bench.test.ts** — the benchmark harness: a scenario table
  `{ name, arm: "legit" | "stale" | "recovery", steps, expectFinal }` where steps are direct
  invocations of the REAL tools sharing one `SeenLedger` + temp DB, with `external(fn)` steps
  mutating fixtures via raw `fs` (simulating user/git/bash). No agent loop is needed — the
  guard lives in tool execute — so no faux provider. Scenarios: L1 read-full→edit; L2
  window-read→edit inside window; L3 grep→edit matched line; L4 write→edit; L5 edit→edit
  below (shift); L6 identical-bytes external rewrite→edit; L7 replace_all within window; L8
  multi-file grep→edit second file; L9 multi-line old_string; L10 read→edit→read→edit; L11
  CRLF; L12 whole-small-file edit. Stale: S1 read→append→edit; S2 never-read→edit; S3
  read→in-place modify→edit; S4 window L1-10→edit at L50. R1 = S1 + scripted re-read of the
  `details.reread` ranges + retry. Each scenario runs twice (guard ON / OFF); the test
  computes success/rejection counts and asserts the §6 AC7 thresholds exactly.
- **tests/config_env.test.ts** (extended) — AC6, using the file's existing env save/restore
  harness.

## 8. Manual-test scenario sketch (per acceptance criterion)

Ledger query used throughout:
`sqlite3 ~/.minima-harness/minima.db "SELECT path, start_line, end_line, substr(file_hash,1,8), tool FROM seen_lines WHERE run_id=(SELECT run_id FROM runs ORDER BY created DESC LIMIT 1) ORDER BY path, start_line;"`

- **AC1/AC4 (stale + recovery)**: in `minima`, prompt: `Read src/tools/edit.ts, then wait for me.`
  In another terminal: `echo "// drift" >> src/tools/edit.ts`. Then prompt:
  `Now change the description string in editTool to say "Replace one exact string".`
  Expect on screen: a rejected edit result starting `edit: stale file: … re-read these ranges: …edit.ts:1-57`,
  then the model re-reading and the retried edit succeeding. Verify the ledger query shows a
  fresh `read` row whose hash prefix changed after the re-read.
- **AC2 (read stamp)**: prompt: `Read package.json.` Expect the tool result to end with
  `[snap:xxxxxxxx]`; verify `shasum -a 256 package.json | cut -c1-8` matches, and the ledger
  query shows `package.json|1|<n>|<same 8>|read`.
- **AC3 (grep stamp + grep→edit)**: prompt: `grep for "MAX_MATCHES" in src/ and change its value to 250.`
  Expect grep output ending `[snap:xxxxxxxx 1 files]` and the edit to succeed WITHOUT a full
  read; ledger shows a `grep` row for `src/tools/grep.ts` covering the matched line.
- **AC5 (schema)**: `sqlite3 ~/.minima-harness/minima.db ".schema seen_lines"` shows the table + index.
- **AC6 (flag off)**: `MINIMA_TUI_EDIT_GUARD=0 minima`, repeat the AC1 scenario. Expect the
  pre-P3 behavior: no `[snap:` lines, the post-drift edit applies immediately, and the ledger
  query returns zero new rows for this run.
- **AC7**: `cd packages/tui && bun test tests/edit-bench.test.ts` — 100% pass; thresholds are
  hard assertions, so pass == no regression.

## 9. Integration notes (PR train order P1 → P2 → P4 → P3; declared against P1's map)

- **grep.ts (P1 ∩ P3)**: P1 declared (their §3/§9): `executeWithin` param head (52–56) + ONE
  added option in the `boundText` call (88–92); they deliberately left body assembly (93–99)
  to P3. P3's regions: **93–99** (snap tag append + evidence recording — P1-free zone),
  **52–56** (SHARED: both add one parameter — trivial union merge), **102–112** (factory
  opts threading; P1 touches only via the same param union), imports 1–7 (union). Merged
  body order pinned in §4 (snap tag last, after P1's spill-suffixed notice).
- **read.ts (P1 ∩ P3)**: P1 declared lines 33–35 (two-line resolve branch). P3's regions:
  **50–54** (readLines call gains `hasher`, snap line appended, evidence recorded, details
  extended) + imports 5–12 (union). Disjoint from P1's 33–35 — same function, different
  lines; semantic merge trivial.
- **types.ts / builtin.ts / main.ts (P1 ∩ P3)**: sibling additive options (`artifacts` /
  `seen`) in `FsToolOptions`, `BuiltinToolsOptions` + the `fs` object (builtin.ts:63),
  `toolsFor` (main.ts:551–567), tool assembly (~670), and the attach site (806–808) — pure
  union merges, both features follow the same late-bind pattern.
- **_io.ts**: P3-only (P1 declared it untouched) — additive `hasher` opt + `eof` return field.
- **minima_db.ts MIGRATIONS tail (P1 ∩ P3)**: textual conflict only; the P3 batch touches no
  existing tables and commutes (§4). Expected final position 20 (P4 ships no batch); never
  pinned.
- **config.ts**: sibling flag lines beside P1/P2/P4's — union merge.
- **agent/agent.ts + agent/loop.ts**: P3 touches NEITHER (enforcement lives in edit.ts
  execute, not the hook stack at agent.ts:119–126) — no collision with P2/P4's loop work.
- **Schema snapshot**: zero tool params added → assert at review that
  `tests/__snapshots__/tool-schemas.test.ts.snap` has zero diff.
- **Seam freeze**: `_bounds.ts`/`_rg.ts` byte-identical
  (`git diff origin/feat/boosting -- src/tools/_bounds.ts src/tools/_rg.ts` → empty).
