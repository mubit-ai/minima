# MUB-206 — Edit guard v2: apply_patch + write coverage, per-agent scoping — Wave 4, merges 4th

> Plan pass 2026-07-24 against feat/boosting @ ba6eb32. Harness: `packages/tui`. Line numbers are anchors — re-verify at build time.
> Merge slot: after MUB-204 (TTSR), before MUB-207 (compact2) — train 205→203→204→**206**→207.

## 1. Scope + non-goals

**In scope**
1. `apply_patch` joins the P3 seen-ledger contract on both sides, enforced **inside its `execute`** (same in-execute pattern as `edit.ts` — hooks can't resolve paths against per-sub-agent workdirs):
   - **Check (pre-write):** every Update-File hunk guarded — stale file hash or unseen target lines → rejection with deterministic `re-read these ranges:` recovery, aggregated across all failing files into ONE message, **no file touched** (all-or-nothing extends to guard rejections).
   - **Record (post-write):** record full-file evidence; updates/moves remap prior evidence through per-hunk deltas + record fresh hunk spans (edit.ts→applyEdit semantics generalized to per-hunk deltas); deletes forget the path. Kills the P3 patch-then-`edit` stale round trip.
2. `seen_lines.agent_id` population + per-agent ledger scoping (lead = NULL, children = childId), threaded through `SeenLedger.attach` and the two `MinimaDb` seen-lines methods.
3. **Sub-agent enablement: IN scope** (§4.3) — children get their own agent-scoped ledger. The only reason P3 excluded children (shared `(run_id, path)` key, no agent isolation) is exactly what agent_id scoping removes. This lands the D5 "sub-agent parity" seed now.
4. `write` coverage: **verified, no gap, no change** (§2).

**Non-goals**: no guard on `write` overwrites of unseen existing files (record-only for write; v3 candidate) · no guard on Add File / Delete File / zero-context pure-insertion hunks (nothing "seen"; file-hash stale check still applies to updates) · no `[snap:]` tag on apply_patch output (consistent with edit/write — only read/grep stamp) · no bash-write tracking (P3 hole, unchanged) · no new index, no migration (§7) · no Wave-5 LSP anticipation in apply_patch.ts.

## 2. Full write-set

| File | Change |
|---|---|
| `src/tools/_seen.ts` | `SeenTool` union gains `"apply_patch"`. `staleMessage`/`unseenMessage` gain a trailing optional `tool = "edit"` prefix param (P3 output byte-identical by default; apply_patch passes `"apply_patch"`). Generalize internal `remapThroughEdit`/`spansAfterEdit` to per-span deltas (`edits:{span,delta}[]`); `applyEdit` becomes a thin uniform-delta wrapper (P3 behavior identical — seen-ledger tests + bench prove it). New `SeenLedger.applyEdits(srcPath, destPath, {edits, newHash})` (src===dest in-place; src!==dest remaps to dest + clears src = the move case) and `SeenLedger.forget(path)` (delete case). `attach(index, runId, agentId: string\|null = null)`. `SeenIndex.listSeenLines`/`replaceSeenLines` gain a TRAILING optional `agentId` (structural fakes keep compiling). |
| `src/tools/apply_patch.ts` | `preloadFiles` reads raw `Buffer` + returns `{text, hash}` (hash of raw bytes — same basis read.ts streams / edit.ts hashes; today's utf8-string hash diverges on non-UTF8). `applyHunks` additionally returns per-hunk `{span (1-based ORIGINAL coords), delta}` via an applied-offsets list (handles the `find`-from-0 out-of-order fallback; unit-tested). `PatchPlan` gains additive `updates:{src,dest,edits}[]` (`parsePatch`/`planPatch`/`writePlan`/`PatchError` signatures unchanged; `applyHunks` module-private). `execute`: guard block between `planPatch` and `writePlan` (fail-open: `seen?.enabled` false or `rows(path)===null` skips, per P3), record block after `writePlan`. Rejection mirrors edit.ts: `{content:[text(msg)], details:{error:true, edit_guard:"stale"|"unseen", reread}}`. |
| `src/db/minima_db.ts` | `listSeenLines`/`replaceSeenLines`/`deleteSeenLines` gain trailing `agentId: string\|null = null`; WHERE becomes `... AND agent_id IS ?` (SQLite `IS ?` binds NULL); INSERT binds `agentId` not literal NULL. Existing direct calls keep compiling via the default. **No MIGRATIONS change.** |
| `src/minima/spawn.ts` | In `createSpawn`'s per-child body (beside `builtinTools`): construct a child `SeenLedger` when `parent.config.editGuard && parent.db && parent.runId`, `attach(parent.db, parent.runId, childId)`, pass as `seen`. `childId` exists before tool construction. **Rebase point:** typed-task (205) merges first and may touch spawn.ts; this is ~5 lines adjacent to `builtinTools({...})`. |
| `src/tools/builtin.ts` | Doc-comment refresh only (the "sub-agents never pass one" comment goes stale). No code change — `applyPatchTool(fs)` ALREADY receives `seen` via the shared `fs` object and ignores it today. |
| `src/cli/main.ts` | Likely ZERO change: `seenLedger?.attach(db, runId)` picks up `agentId=null` (lead). At most a P3 comment. |
| `src/tools/write.ts` | **No change.** Verified: write already records post-write full-file state (`opts.seen.record(path, sha256Hex(content), [{start:1,end:n}], "write")`). The `writeText` trailing-newline over-count is a harmless superset (edit target spans come from real body content, no false-accept reachable). Don't touch. agent_id coverage comes free via the ledger. |
| `src/tools/types.ts` | Doc-comment refresh of the `seen` option (optional). |
| Tests | New `tests/apply-patch-guard.test.ts`; additions to `tests/seen-ledger.test.ts` (applyEdits/forget/agent-scope units) and `tests/spawn.test.ts` (child ledger threading — faux-provider harness supports scripted toolCall blocks). **`tests/edit-bench.test.ts` NOT modified** — regression gate, stays pristine. |

**Snapshot/version-stamp: no change** — apply_patch params stay `{patch}`, write stays `{path,content}`; `toolSchemaHash` hashes name+params only.

## 3. Flag semantics

Rides **`MINIMA_TUI_EDIT_GUARD`** (P3, `config.editGuard`, default ON). **No sub-flag** — apply_patch guarding is the same read-before-edit contract at a different entry point, and the tool description steers the model toward apply_patch for multi-region changes; a guard-on-but-patch-off state would make the *steered-to* path the unguarded bypass, gutting P3's guarantee (and doubling the guard test matrix). Flag OFF: `main.ts` never constructs the ledger + spawn.ts's block is gated on `parent.config.editGuard` → `opts.seen` undefined everywhere → every new path sits behind `seen?.enabled`/`rows!==null` → byte-identical to today for lead AND children. Fail-open parity with P3 (unattached / broken index / per-file rows===null → all checks + recording skipped).

## 4. agent_id + per-agent scoping

- **4.1 Key**: `(run_id, agent_id, path)`. Lead = `agent_id IS NULL`; child = `childId` (the `${step_id}-${newId().slice(0,8)}` identity spawn.ts already uses for `child.agentId` + the DB sink). Back-compat free: every v1 row was NULL and was the lead's.
- **4.2 Plumbing**: `SeenLedger` stores `agentId` from `attach(...)`, passes it as the trailing arg on every `listSeenLines`/`replaceSeenLines`; `MinimaDb` filters `agent_id IS ?` + binds on insert. Existing index `ix_seen_lines_key(run_id, path, created)` remains the access path (per-agent filter rides it; small row counts — no new index → no migration).
- **4.3 Sub-agent enablement: ENABLE.** The P3 exclusion existed because an unscoped ledger would cross-poison (a child's read granting the lead unseen-coverage; a child's replace clobbering lead evidence) — agent_id scoping dissolves that. Children are the *primary* stale-edit hazard (parallel non-worktree children race on shared files; the delegation prompt already commands "Read a file before editing"). Cost near zero (bench: 0 false rejections on 12 legit flows; fail-open on missing `parent.db`). Worktree children get isolation twice (distinct paths + distinct agent_id). New child-visible surface: `[snap:]` tags in child transcripts — same feature/flag, acceptable.

## 5. Acceptance criteria (red→green, from `packages/tui`)

- **AC1 stale apply_patch rejected with re-read ranges (BEHAVIORAL RED on existing surfaces: read + external append + apply_patch, no new API in the test).** read (records) → `appendFileSync` drift → Update-File hunk on an unchanged region. Expect `details.error===true`, body matches `/apply_patch: stale file/` + `/re-read these ranges: .*:\d+-\d+/`, disk bytes unchanged, and following `details.reread` then retrying succeeds. Today the patch applies silently → red. `bun test tests/apply-patch-guard.test.ts -t "AC1"`.
- **AC2 patch-then-edit costs no stale round trip (red on P3 surfaces).** read full → apply_patch applies → subsequent `edit` on a different seen region succeeds. Today red: edit stale-rejects because apply_patch never updated the ledger hash. `-t "AC2"`.
- **AC3 fresh/unseen matrix.** (a) read→patch applies content-exact; (b) Add File needs no prior evidence + records full-file (follow-up edit passes); (c) update on never-read file → `unseen` rejection naming original-coordinate ranges; (d) delete clears evidence; move remaps to dest. `-t "AC3"`.
- **AC4 per-agent scoping, two agent ids.** Two `SeenLedger`s on one `MinimaDb(":memory:")`, same runId, `attach(db,"r1","agentA")`/`attach(db,"r1","agentB")`. A reads a file; B's edit → unseen rejection; A's edit succeeds; SQL shows `agent_id='agentA'` rows; a NULL-scoped lead ledger sees none of A's rows. Red today at RUNTIME (Bun strips types → the extra attach arg is ignored → both share rows → B wrongly succeeds). `-t "AC4"`.
- **AC5 sub-agent threading.** In `tests/spawn.test.ts` harness: child scripted to `read` a workdir file → `seen_lines` has a row `agent_id LIKE '<step_id>-%'`; same with `editGuard:false` → zero rows. Red today: children have no ledger. `bun test tests/spawn.test.ts -t "seen"`.
- **AC6 P3 benchmark non-regression (binding gate).** `bun test tests/edit-bench.test.ts` → legit 12/12 ON + 12/12 OFF, stale 4/4 rejected ON / 4/4 applied OFF, R1 recovery passes — test file byte-identical to base (`git diff --stat feat/boosting -- tests/edit-bench.test.ts` empty).
- **AC7 flag-off parity.** OFF arm: AC1 scenario's patch applies with today's exact success text; AC4 scenario's edit applies.
- Suite-wide: `bun test && bun run check && bun run lint`, plus `MINIMA_TUI_EDIT_GUARD=0 bun test` green.

## 6. Test plan (hermetic)

House conventions from `edit-guard.test.ts`/`edit-bench.test.ts`/`spawn.test.ts`: `mkdtempSync`+`rmSync`, `MinimaDb(":memory:")` or temp DB files, tools via `parameters.validate`+`execute(id,value,null,null)`, no network/model. New `tests/apply-patch-guard.test.ts` (AC1–AC4 + AC7, real-DB + OFF arms, multi-file aggregation). Extend `seen-ledger.test.ts` (applyEdits per-span-delta incl. out-of-order + move, forget, agent-scope isolation, fail-open) and `spawn.test.ts` (AC5 pair). `apply_patch.test.ts`/`apply_patch_async.test.ts` untouched (no `seen` passed → byte-identical = the no-ledger parity proof).

## 7. Migration: NONE (confirmed)

`seen_lines.agent_id TEXT` already exists (P3 batch, "reserved for sub-agent scoping (NULL in v1)"); today's insert binds literal NULL. v2 only changes what the existing methods bind/filter. No new table/column/index; v22 (bgjobs) untouched. If a schema need surfaces → STOP and flag.

## 8. Sequencing + collisions

1. Red commit: `apply-patch-guard.test.ts` + spawn/seen-ledger additions.
2. `_seen.ts` helper generalization + `applyEdits`/`forget`/message prefix/attach agentId.
3. `minima_db.ts` trailing agentId on the 3 methods.
4. `apply_patch.ts` preload hashes + hunk-span tracking + guard/record blocks.
5. `spawn.ts` child ledger + comment refreshes.
6. Gates incl. `edit-bench`.

Collisions: `spawn.ts` shared with typed-task (205, merges first) — small adjacent block, rebase trivially, re-verify AC5 post-rebase. `minima_db.ts` — no MIGRATIONS touch (method-signature edits only), disjoint from bgjobs' appended v22 batch. No snapshot change. Known risks: original-coordinate mapping under the find-from-0 fallback (mitigated by applied-offsets bookkeeping + unit test); message-prefix parameterization must keep edit.ts output byte-identical (bench R1 + stale arm pin it).
