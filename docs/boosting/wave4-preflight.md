# Wave 4 preflight — MUB-203..207 plan-coordinated fan-out

> Written 2026-07-24 by the Waves-3-5 orchestrator. Base: `feat/boosting` @ `ba6eb32`
> (Wave 3 merged: SSRF + CI + artifact-GC + steer2). This wave builds the five runtime-power
> features in parallel worktrees behind opt-out flags; integration is a later serial train.
> Companion to the five `w4-<slug>-plan.md` docs (the per-slice contracts) and
> `waves-3-5-orchestration.md` §7 (process). On any conflict: code > approved plan docs >
> this preflight > orchestration doc > analysis.

## Locked decisions (arc)

- Plan-coordinated parallel: all five plan docs + this preflight committed to `feat/boosting`
  BEFORE any worktree forks. bgjobs (W4.1) and TTSR (W4.2) planned back-to-back for the R2
  `loop.ts` partition; the other three in parallel.
- Every feature ships behind a `MINIMA_TUI_*` flag with the flag-off path byte-identical.
  **Default ON for four; default OFF (opt-in) for TTSR — owner decision below.**
- Owner checkpoint after these docs (with the three surfaced decisions), before implementation.

## R2 resolution — `loop.ts` partition (was the headline collision risk)

**Verdict: TRIVIAL PARTITION, no serialization needed.** bgjobs (W4.1) declares `src/agent/loop.ts`
untouched — ZERO hunks — reaching the abort tree through the signal the loop already passes every
tool (`loop.ts:461`). TTSR (W4.2) therefore owns the entire stream-consumption region (~94-134)
outright. Both plans independently re-derived the region boundaries and agree. No hunk of either
slice lands in the other's territory; neither restructures the file. W4.2 need not fork after
W4.1 — they build fully in parallel.

## Migration reservation

DB at **v21** (21 batches; last two = `artifacts`, `seen_lines`). One new batch this wave:

| Slice | Migration | Tables touched | Position |
|---|---|---|---|
| W4.1 bgjobs | ONE batch — `bg_jobs` table + 2 indexes | `bg_jobs` ONLY (no ALTER, no existing table) | **v22 RESERVED** |
| W4.2 TTSR | none (turn-local state + telemetry counter) | — | — |
| W4.3 typed-task | none (in-memory `ChildResult.data`) | — | — |
| W4.4 editguard2 | none (uses P3's existing always-NULL `seen_lines.agent_id`; method binds/filters only) | — (no MIGRATIONS edit) | — |
| W4.5 compact2 | none (`"compact"` is a new `tool_name` value in the existing `artifacts` table) | — | — |

Only **v22** is consumed, by bgjobs, for a fully self-contained table → commutes with everything.
No slice may claim another number; if any implementer concludes a migration is needed, STOP and
escalate (orchestrator reserves the next number).

## Consolidated write-set + collision matrix

| File | Slices touching it | Collision class + resolution |
|---|---|---|
| `src/agent/loop.ts` | TTSR only | R2: bgjobs zero hunks → TTSR sole owner, no conflict |
| `src/agent/state.ts` / `agent.ts` | TTSR only | bgjobs declares both untouched |
| `src/tools/bash.ts` | bgjobs only | — |
| `src/db/minima_db.ts` | bgjobs (append v22 batch) · editguard2 (method signatures, NO MIGRATIONS edit) | Disjoint: bgjobs appends to MIGRATIONS tail; editguard2 edits `listSeenLines`/`replaceSeenLines`/`deleteSeenLines` bodies. No textual overlap |
| `src/minima/spawn.ts` | typed-task (enforcement/re-ask) · editguard2 (child ledger ~5 lines) | typed-task merges FIRST; editguard2 rebases its adjacent block. Re-verify editguard2 AC5 post-rebase |
| `src/tools/task.ts` | typed-task only | — |
| `src/tools/apply_patch.ts` / `_seen.ts` | editguard2 only | — |
| `src/tui/compact.ts` | **TTSR + compact2** | **REAL collision on `compactMessages`.** compact2 spills the pruned window to an artifact; TTSR adds a preserve-verbatim partition for its reminders. Compose, don't overwrite. **Train order TTSR(204) before compact2(207): TTSR's partition lands first, compact2 rebases and keeps BOTH branches** (`[summaryMsg, ...preservedTtsrReminders, ...recentMessages]` with the spill). compact2's implementer is briefed on this at fork |
| `src/minima/runtime.ts` | TTSR (1 constructor line) · compact2 (1 late-bound field ~184-225) · bgjobs (none) | Disjoint regions (constructor super() call vs field decls vs recovery ladder) — union-merge |
| `src/minima/config.ts` | ALL FIVE (one flag field + default + env-parse line each) | Sibling-flag union, Wave-2-safe class. typed-task merges first = base; others append |
| `src/cli/main.ts` | typed-task (~969-973 taskTool opts) · bgjobs (4 hunks: construct/toolsFor/attach/shutdown) · editguard2 (likely zero) · compact2 (1 wiring line ~759/844) | Declared-disjoint regions; union-merge in train order |
| `src/tools/builtin.ts` / `types.ts` | bgjobs (bgJobs option) · editguard2 (comment refresh only) | Disjoint |
| `tests/tool-schemas.test.ts` + `.snap` | typed-task (D1: pins the task tool for the first time) · bgjobs (adds bgjobs-on bash + bgjob) | Snapshot conflict class. Resolution ALWAYS: take merged code, REGENERATE (`bun test tests/tool-schemas.test.ts -u`-style), never hand-merge. typed-task first, bgjobs regenerates over it |
| `tests/config_env.test.ts` | all five (append one flag triplet each) | Append-only union |

## Merge-train order (fixed) + rationale

**205 typed-task → 203 bgjobs → 204 TTSR → 206 editguard2 → 207 compact2.**
- typed-task first: most isolated (task.ts/spawn.ts), and it pins the task tool surface (D1) that bgjobs' snapshot change must regenerate over.
- bgjobs second: brings v22 + the snapshot additions; rebases over typed-task's main.ts/snapshot.
- TTSR third: loop.ts is sole-owned (R2), rebases only over config.ts/main.ts unions; lands the compact.ts preserve-partition BEFORE compact2.
- editguard2 fourth: rebases its spawn.ts child-ledger block over typed-task's spawn.ts edits.
- compact2 last: consumes the most surfaces (`_artifacts.ts` + W3.3 GC + compact.ts) and must compose its spill branch with TTSR's compact.ts preserve-partition.

Each merge: rebase on the current tip → re-run all gates → regenerate the snapshot if it conflicted → confirm PR CI green → merge → Linear Done. One at a time, never two between gate runs.

## Integration-risk register (preconditions for the train)

1. **compact.ts compose (TTSR × compact2)** — the one genuine multi-slice semantic merge. compact2's rebase must keep TTSR's `isTtsrReminder` preserve-partition AND its own spill; a gate (AC7 of TTSR: reminder survives compaction) + compact2's AC1 (losslessness) both green post-rebase is the proof.
2. **Snapshot regeneration (typed-task × bgjobs)** — mechanical; regenerate, never hand-merge; audit the diff shows only additive entries.
3. **spawn.ts (typed-task × editguard2)** — small adjacent blocks; re-verify editguard2 AC5 post-rebase.
4. **v22 uniqueness** — only bgjobs appends a batch; no other slice touches MIGRATIONS. Mechanical check at train time: `git diff` on `minima_db.ts` MIGRATIONS shows exactly one new batch.
5. **Flag-off matrix at wave end** — full suite with ALL FIVE new flags forced off must equal the all-on default suite count (byte-identity proof).

## R4 integration-evidence PR (closes the wave, after the train)

`feat/boost-w4-integration` off the post-train tip — three cross-feature hermetic tests + one PTY smoke:
- **compact2 × GC**: a compaction-spilled artifact survives GC at a tiny byte budget (run_id exemption) — compact2's AC4 already encodes this; the integration PR re-runs it against the merged tree.
- **TTSR × meter**: a tripwire-retried turn books usage per the approved accounting decision (no double-book) — TTSR's AC4 against the merged tree.
- **bgjobs × session-end**: orphan policy enforced at session end per the approved decision.
- **PTY smoke**: `make tui-verify` harness with all new flags on.

## Owner decisions — RESOLVED 2026-07-24 (binding on the implementers)

1. **bgjobs orphan policy** = **(a) KILL live jobs at session end** via `registry.shutdown()` in `closeDb`; startup reaper marks/identity-verified-kills crash leftovers only. Sub-choices confirmed: single `bgjob` action-enum tool; Esc kills jobs launched under that run's signal; reaper never blind-kills.
2. **TTSR accounting** = **(b) discard the aborted partial's usage** — only the successful retry books. Zero-touch on `usageSince`; no fabricated numbers in the honest-cost substrate. AC4 asserts it.
3. **TTSR default** = **OFF / opt-in** via `optInFlag(MINIMA_TUI_TTSR, experimental)`. Deliberate deviation from the arc's default-ON convention (a mis-firing tripwire aborts real turns; promote to default-ON in a follow-up after field-validating the rule table).

Orchestrator-decided (recorded, not owner-blocking): typed-task D1 (pin the task tool surface now) · D2 (strict authoring-time schema allowlist) · D3 (keep `phase:subtask` re-ask tag) · editguard2 sub-agent enablement IN scope · bgjobs single-tool roster.

Orchestrator-decided (recorded, not owner-blocking): typed-task D1 (pin the task tool surface now) · D2 (strict authoring-time schema allowlist) · D3 (keep `phase:subtask` re-ask tag) · editguard2 sub-agent enablement IN scope · bgjobs single-tool roster.
