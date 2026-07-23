# Wave 2 preflight — P1–P4 plan-coordinated fan-out

> Written 2026-07-23 by the Wave-2 orchestrator. Base: `feat/boosting` @ `49ef395`
> (superset of `main` 0.14.1). This wave BUILDS the four roadmap §E features in parallel
> worktrees and stops at pushed branches — no PRs, no merges. Integration happens in a
> later PR train after the user's manual testing.

## Locked decisions (2026-07-23)

- **Plan-coordinated parallel**: all four plan docs are committed to `feat/boosting`
  BEFORE any worktree forks, so every feature worktree carries all four plans. P3's plan
  pass runs AFTER P1's plan exists and must declare its collision surfaces against it.
- **User checkpoint** after the four plan docs, before any implementation.
- **P2 scope**: core trio — bash interceptor + retry classifier + tool-scoped abort
  placeholders. No TTSR (stays a stretch goal).
- **Flags**: every feature defaults ON behind a `MINIMA_TUI_*=0` opt-out wired through
  `src/minima/config.ts` (mirror the memory/bigPlan flag shape). Enforcement gated on
  config, never prompt text.
- Linear centralized in the orchestrator (sub-issues under MUB-188; In Progress at
  implementation start, In Review when pushed + verified; never Done this wave).

## Migration assignments

Schema is at version **18** (18 batches in `MIGRATIONS`, `packages/tui/src/db/minima_db.ts`).
Convention (see the comment near `minima_db.ts:367` + the divergent-lineage self-heal):
append ONE idempotent batch at the END; batch position may shift at rebase; **no hardcoded
version index anywhere** (tests introspect, never pin numbers).

| Feature | Migration | Expected integration position |
|---|---|---|
| P1 output economics | 1 batch (`artifacts` index) | 19 |
| P2 loop robustness | none (confirmed by plan) | — |
| P4 checkpoint/rewind | **none** (rides the existing `events` table — plan §4) | — |
| P3 edit engine | 1 batch (`seen_lines` ledger) | 20 |

Locally each worktree's batch lands at position 19 — fine, nothing integrates this wave.
Every batch statement must be safe to replay idempotently (the self-heal replays all
batches on every open).

## Predicted write-set map (final map = the plan docs)

| Feature | Branch / worktree | Predicted source writes | Tests |
|---|---|---|---|
| **P1** artifacts | `feat/boost-p1-artifacts` / `minima-boost-p1-artifacts` | new artifact-store module; `_bounds.ts` spill *call sites* in `grep.ts`/`glob.ts`/`ls.ts`; `bash.ts` (tee-to-file — BoundedBuffer never holds full output); `minima_db.ts` (+1 batch); `config.ts` flag; possibly `read.ts` paging | new `tests/artifacts*.test.ts` |
| **P2** loop | `feat/boost-p2-loop` / `minima-boost-p2-loop` | interceptor module + registration (hook stack exists at `src/agent/agent.ts:121`); retry-classifier touchpoints (`src/minima/redo.ts`, recovery ladder in `loop.ts`); abort placeholders; `config.ts` flag | new `tests/steer*.test.ts` etc. |
| **P3** edit | `feat/boost-p3-edit` / `minima-boost-p3-edit` | `read.ts`/`grep.ts` (snapshot-tag stamping); `edit.ts` (stale rejection); ledger module; `minima_db.ts` (+1 batch); `config.ts` flag; benchmark harness | new `tests/edit_guard*.test.ts` + benchmark |
| **P4** rewind | `feat/boost-p4-rewind` / `minima-boost-p4-rewind` | new `checkpoint`/`rewind` tools + `builtin.ts` registration (additive schema snapshot update); projection changes in `loop.ts`/`state.ts`; `minima_db.ts` (+1 batch if needed); `config.ts` flag | new `tests/rewind*.test.ts` |

## Integration-risk register (preconditions for the later PR train)

1. **Migration commutativity is NOT assumed.** Before the PR train runs, confirm the
   P1/P3 batches are commutative — no order-dependent interaction on shared or related
   tables (P2 and P4 ship no batch, so the audit shrank to this one pair). Plan-pass
   outcome: both batches are `CREATE … IF NOT EXISTS` of their own objects and declare
   **zero existing tables touched** — commutativity is expected trivially true, but the
   mechanical check (diff each batch's table list) still runs at train time.
2. **P1 ∩ P3 — read/grep output surface.** P1 spills at `boundText` call sites; P3 stamps
   output with snapshot tags. Both plans declare their exact touch regions in `grep.ts` /
   `read.ts`; expect a real (small) semantic merge, not just textual.
3. **P2 ∩ P4 — agent loop.** Interceptor/classifier vs projection/rewind both touch
   `loop.ts`/`agent.ts`. Both plans declare exact touchpoints.
4. **Schema snapshot**: P4 (new tools) and any P2 schema-visible change update
   `tests/__snapshots__/tool-schemas.test.ts.snap` — each update must be additive-only and
   deliberate; at integration the snapshot merges are re-generated, not hand-merged.
5. **Frozen seam**: `_bounds.ts`/`_rg.ts` signatures unchanged by all four. Any additive
   seam need = orchestrator sign-off (reopens seam freeze), last resort.
6. Expected PR-train order: **P1 → P2 → P4 → P3** (matches migration positions; P3 last —
   biggest, riskiest, most overlapped).

## Plan-pass outcomes (2026-07-23, orchestrator audit)

The four plan docs (`p1-artifacts-plan.md`, `p2-loop-plan.md`, `p3-edit-plan.md`,
`p4-rewind-plan.md`) supersede the predicted write-set map above. Key deltas + findings:

- **P4 needs NO migration** — checkpoint anchors derive from the transcript; the rewind
  marker is one row in the existing `events` table (unconstrained `type` TEXT). P4 also
  found a **naming collision**: `src/session/checkpoint.ts` / `src/session/rewind.ts` and
  the `rewind` event type already belong to the user-facing snapshot/prompt-rewind systems —
  P4 uses the distinct `context_rewind` event type and new file names.
- **P2's enforcement choke point is singular**: the only silent turn-replay site is the
  recovery ladder's context rollback (`src/minima/runtime.ts:787`); the provider layer has
  no retry loops. Hook-order contract: bash-steer registers FIRST on the beforeToolCall
  stack (ahead of TUI permission + checkpoint/done-gate hooks; first block wins).
- **P3 enforces inside `edit.ts` execute** (not a hook — hooks can't resolve paths against
  per-sub-agent workdirs), extends `_io.ts` `readLines` additively (`hasher` opt + `eof`
  field; P1 leaves `_io.ts` untouched), and its grep/read regions are declared line-exactly
  against P1's map (grep body assembly 93–99 vs P1's boundText opts 88–92; read 50–54 vs
  P1's 33–35).
- **Line anchors audited**: orchestrator spot-checked every load-bearing file:line claim in
  all four docs against `49ef395` (loop.ts 159/161 + 405–411 + 442–461, agent.ts 244–250,
  runtime.ts 787, rehydrate.ts 130–136, edit.ts 30–54, write.ts ~30, read.ts 50–54,
  bounds B8, main.ts 551–567/717–723) — all accurate.
- **Shared-file overlap summary** (all declared, all union-merge class): `config.ts` ×4 ·
  `main.ts` P1/P2/P3/P4 in disjoint regions · `types.ts`/`builtin.ts` P1+P3 sibling options ·
  `state.ts` P2+P4 one additive field each · `loop.ts` P2 (runOneTool) + P4 (turn boundary),
  disjoint · `spawn.ts` P1+P2, different regions.

## Proposed flag names (final name in each plan doc)

`MINIMA_TUI_ARTIFACTS` (P1) · `MINIMA_TUI_STEER` (P2) · `MINIMA_TUI_EDIT_GUARD` (P3) ·
`MINIMA_TUI_REWIND` (P4).

## Verification protocol (orchestrator, per finished feature)

1. Constraint audit: `git diff --stat origin/feat/boosting...HEAD` ⊆ the plan doc's
   declared write-set; seam files byte-identical; `package.json`/lockfile untouched;
   schema snapshot diff additive-only.
2. Independent gates re-run: `bun test` · `bun run check` · `bun run lint`.
3. **Red-proof, clean-base method** (Wave-1's `git checkout base -- src/` is unsound for
   DB-backed features: it leaves new modules in place and creates schema half-states):
   scratch worktree at `origin/feat/boosting` → copy ONLY the feature's new test files →
   `bun install` → run them → expect FAIL → record the failure mode. Missing-module/table
   failures count as red but are weak evidence; each plan includes ≥1 test that reds on a
   behavioral assertion against existing surfaces.
