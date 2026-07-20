# Big Plan — Master Execution Plan *(RETIRED)*

> **RETIRED 2026-07-16 — do not execute from this file.** The build-out it planned landed
> through B5/U3 (see §9); it is kept as the record of what was built and why. Unfinished rows
> (A5–A7, B6) remain Track A/B backlog; J1's E2E-demo intent lives on as MP19 of the
> successor. **The successor and current source of truth is
> [`inline-ux-guide.md`](inline-ux-guide.md)** — the post-implementation revision (inline-only
> rendering, fullscreen/sidebar removal, panel system, plan-workflow polish), built from
> issues found after this plan was implemented.

> **This file is the single source of truth for execution.** It absorbs
> `docs/PLAN/ground-truth-plan.md` stages 3–8 (MUB-111…127) and the borrow roadmap from
> `minima-harness-application-guide.md` (Part 2). Where documents disagree, **this file wins**.
> The GT doc stays authoritative for the frozen verification contract (`src/minima/gt_contract.ts`)
> and the stage 0–2 record; the guide stays authoritative for the *why* behind each borrow.
>
> **Linear project:** [Minima – Big Plan](https://linear.app/mubit/project/minima-big-plan-af98e58f1f1a/overview)
> **Branch:** `feat/BP-UX` (off `main`) — `feat/plan-sqlite-merge` is **retired**; the GT
> ledger work it carries (schema v3–v5, GT stages 0–2) must be re-landed on this lineage
> before Track A's A1 · **Harness:** `packages/tui` (TS/Ink on Bun) · **Flag:** `MINIMA_TUI_GROUND_TRUTH`

---

## 0. Plan contract (this plan follows its own seven properties)

```
done:     every phase gate green (A1–A7, B1–B5, U1–U3, J1) · E2E demo (MUB-127) passes in
          bun test · PTY-shot suite committed under docs/BigPlan/shots/
cap:      one phase = one gated commit (one PR per track slice); a phase gate may fail at
          most 2 review rounds before replanning
escalate: gate fails twice → joint session, re-scope the phase IN THIS FILE before more code;
          any change to a Phase-0 shared surface → the other SWE reviews before merge
effort:   2 SWE × ~6 weeks · sizes: S ≤2d, M 3–4d, L 5d+ — calibrated against GT stages 0–2
          (each landed as ~M with the same codebase and tooling)
store:    this file · re-project: read your track's next ⬜ phase at session start; flip its
          status at phase exit (⬜ → 🟦 in-progress → ✅ done)
replan:   after each phase gate — reorder/resize the remaining phases here, don't railroad
```

---

## 1. Tracks and ownership

| | **Track A — deterministic guards** | **Track B — session & UX** |
|---|---|---|
| Owner | SWE-A | SWE-B |
| Owns | `src/agent/`, `src/minima/`, `src/db/` | `src/session/`, `src/tui/`, `src/cli/` |
| Theme | the harness **enforces** the plan | the human **sees and steers** the plan |
| Layer | deterministic (hooks, caps, gates) | visibility + replan UX (checkpoints, modes) |

**Shared surfaces** — created in Phase 0, then frozen; changes require the other SWE's review:

1. `src/agent/policy.ts` (new) — `PolicyBundle` glob grammar + `GuardEvent` type
2. Footer-strip **slot API** in `src/tui/` — one badge surface both renderers draw
3. `src/db/minima_db.ts` step columns (`verify_max_blocks`, `tools`) — **deferred**: this
   lineage is at schema v2 (no `plan_steps` yet); the columns ride the migration that
   re-lands the plan-ledger tables (prerequisite for A1)
4. `src/tools/` type signatures
5. Usage emission in the agent loop (U1): per-turn `{model, tokens, costUSD}` events consumed
   by the session store — Track B implements, Track A reviews (it lives beside the loop)

**Sync points:** end of A2/B2 (first cross-consumption of `PolicyBundle`) and end of A4/B4
(escalation tiers ↔ escalation UX). Integration branch: `feat/BP-UX` (off `main`);
`feat/plan-sqlite-merge` is retired.

---

## 2. Phase gate definition (applies to every phase)

1. **bun test** — the phase lands with its own tests; full suite green (`packages/tui/tests/`).
2. **PTY shot** — any phase with visible UX commits ≥1 `make tui-shot` artifact to
   `docs/BigPlan/shots/<phase>-<renderer>.png`. Phases touching the footer/prompt area must
   shoot **both renderers** (fullscreen glued-prompt default and `MINIMA_TUI_INLINE`).
3. **Ledger proof** — phases that write GT tables assert the row in a test, not in prose.

A phase is *not done* until all three hold. This is the plan's own §1 (verifiable steps).

---

## 3. Phase 0 — Interface contract *(BOTH SWEs · S · blocks everything)*

Objective: freeze the surfaces both tracks touch so they never merge-conflict again.
Boundary: types, grammar, one migration, one footer slot — **no feature behavior**.

| # | Step | Verify |
|---|---|---|
| 0.1 | `src/agent/policy.ts`: `PolicyRule {tool, pattern, action: allow\|ask\|deny}` + `PolicyBundle` with **last-match-wins** glob resolution (OpenCode semantics: `*` first, specifics after, per-agent override) | `tests/policy.test.ts` table tests incl. override + last-match-wins cases |
| 0.2 | `GuardEvent` type: `{kind: verify-block\|doom-loop\|steps-cap\|allowlist-deny\|mode-ask, stepId?, tier?, detail}` — the one event both tracks emit and the footer + ledger consume | type-level test + stub emitter round-trip |
| 0.3 | ~~Migration~~ **Deferred to the GT re-land** (this lineage is schema v2, no `plan_steps`): `plan_steps.verify_max_blocks INTEGER DEFAULT 3` + `plan_steps.tools TEXT` ship inside the migration that brings the plan-ledger tables to this base | `db.test.ts`: fresh-create + upgrade tests land with that migration |
| 0.4 | Footer **slot API**: register a right-side badge slot rendered by both renderers | `layout.test.ts` + PTY shot with a dummy badge, both renderers |

**Exit gate:** merged; both SWEs sign the PR; tracks branch from it.

---

## 4. Track A — deterministic guards (SWE-A)

> **Prerequisite (A0):** re-land the GT ledger from the retired `feat/plan-sqlite-merge`
> branch onto this lineage — schema v3–v5 batches (plans/plan_steps/file_changes/gates/
> user_signals, + the deferred 0.3 step columns) and the stage 0–2 code (todowrite
> persistence, plan projection, DRIFT footer). Cherry-pick or fresh PR; append-only
> migration rules apply.

### A1 — Verify primitive *(GT stage 3 · M)* — MUB-111, MUB-112, MUB-113

| # | Step | Verify |
|---|---|---|
| A1.1 | M3.1: extend `todowrite` schema so a todo carries optional `verify` cmd; `upsertPlanFromTodos` persists it | bun test: todowrite → `plan_steps.verify` populated |
| A1.2 | M3.2 **START HERE**: `runCheck(cmd)` zero-dep shell-out → `{cmd, exitCode, outputTail, durationMs}` | `runcheck.test.ts`: pass / fail / timeout fixtures |
| A1.3 | M3.3: on step → in-progress, run `verify` once, `setStepBaseline` (expect red) | test asserts baseline stored, red recorded |

**Exit gate:** scripted fixture run shows red→green detected against captured baseline.

### A2 — Stop hook + block-done *(GT stage 4 + borrow #2 · M)* — MUB-114, MUB-115, MUB-116

| # | Step | Verify |
|---|---|---|
| A2.1 | M4.1: `beforeToolCall` (`src/agent/loop.ts:232`) intercepts `todowrite` set-`done`; **deny while `verify` fails** | scripted faux-provider run: done blocked |
| A2.2 | M4.2: require **red→green vs baseline** (green-green = pre-satisfied → flag, not verified) | contract test extends `tests/gt-contract.test.ts` |
| A2.3 | M4.3: `insertGate(...)` on verified done | gates row asserted in test |
| A2.4 | **N-strike override**: per-step deny counter; at `verify_max_blocks` (default 3) emit `GuardEvent(verify-block)` → *interim behavior*: stop turn + ask user. Upgraded to tier routing in A4 — **never silent success** | scripted run: 3 denials → escalation event |

**Exit gate:** E2E script in bun test: failing check → blocked ×3 → ask; PTY shot of block notice.

### A3 — Anti-spiral: doom_loop + steps cap *(borrows #1, #4 · M)* — *new Linear issues*

| # | Step | Verify |
|---|---|---|
| A3.1 | **doom_loop**: ring buffer of last 3 tool-call hashes (`tool + canonical-args hash`) in the loop; 3× identical consecutive → `GuardEvent(doom-loop)` → interim stop + ask; record to `gates` so routing learns which (model, step-kind) spirals | unit test on ring buffer + faux-provider loop paused at 3rd repeat |
| A3.2 | **`steps` cap**: agent-config field beside `maxTurns` (`src/agent/agent.ts:88`, default 50); on hit, **inject summarization system prompt** — graceful handoff, not truncation | test asserts final message is a summary listing remaining todos |

**Exit gate:** both guards fire in scripted runs; PTY shot of the doom-loop ask prompt.

### A4 — Confidence tiers + failure kinds *(GT stage 6 · M)* — MUB-120, MUB-121, MUB-122

> Reordered **before** GT stage 5: doom_loop/N-strike route through tiers, and A5's tamper
> detection must *force 🔴* — both need tiers to exist.

| # | Step | Verify |
|---|---|---|
| A4.1 | M6.1: pure fn `confidence(Factors) → verdict` | table-driven unit tests |
| A4.2 | M6.2: tier → behavior: 🟢 silent · 🟡 footer flag (Phase-0 slot) · 🔴 stop + ask | scripted run per tier |
| A4.3 | M6.3: capture user overrides → `recordUserSignal` | user_signals row asserted |
| A4.4 | Re-route A2/A3 escalations: doom_loop 1st → 🟡, 2nd → 🔴; N-strike cap → 🔴 | ladder test: 🟡 then 🔴 |
| A4.5 | Per-failure-kind matcher (à la `StopFailure`): rate-limit → backoff; auth → escalate now; tool-error → replan hint | matcher unit tests |

**Exit gate:** 🟡→🔴 ladder in a scripted run; PTY shot of the 🔴 stop-and-ask, both renderers.

### A5 — Trust the check *(GT stage 5 · M)* — MUB-117, MUB-118, MUB-119

| # | Step | Verify |
|---|---|---|
| A5.1 | M5.1 provenance: pre-existing vs agent-written-this-run | unit tests |
| A5.2 | M5.2 coverage touch (grep heuristic) | unit tests |
| A5.3 | M5.3 tamper (tests weakened/deleted) → **forces 🔴** via A4 | fixture: agent weakens a test → 🔴 in scripted run |

**Exit gate:** tamper fixture goes 🔴 end-to-end.

### A6 — Per-step tool allowlist + task permissions + poka-yoke *(borrows #3, #10 · M)* — extends MUB-111

| # | Step | Verify |
|---|---|---|
| A6.1 | Enforce `plan_steps.tools` (v6 col) via `PolicyBundle` in `beforeToolCall`; violation → deny + **DRIFT** signal + `GuardEvent(allowlist-deny)` | scripted run: off-plan call denied, DRIFT in footer (PTY shot) |
| A6.2 | **task permissions**: same grammar gates which subagents (`src/tools/task.ts`) a step/agent may invoke | policy test with `task:*` rules |
| A6.3 | Static plan lint: flag steps whose declared `tools` can't produce their `verify` (the "web-search for Slack-only info" catch, before any code runs) | lint test fixture |
| A6.4 | Poka-yoke audit of the **full 13-tool set** (read/write/edit/apply_patch/bash/ls/glob/grep/todowrite/task/question/web_fetch/web_search): absolute paths, footgun args | audit lands as a reviewed diff to tool descriptions + schema tests |

**Exit gate:** denial + DRIFT visible; lint catches a bad fixture plan.

### A7 — Learning loop *(GT stage 7 · M)* — MUB-123, MUB-124, MUB-125

| # | Step | Verify |
|---|---|---|
| A7.1 | M7.1: stamp `gt_outcome/gt_verified_by/gt_confidence` via `attachGroundedOutcome` | db assertion in scripted run |
| A7.2 | M7.2: deterministic outcome **outranks** judge feedback | routing unit test |
| A7.3 | M7.3: recovery ladder — failed verification → escalate model tier via router | scripted escalation test |

**Exit gate:** a verified run stamps routing rows; a failed one escalates.

---

## 5. Track B — session & UX (SWE-B)

### B1 — Named sessions + context status line *(borrow #8 · S)* — MUB-134

> **Seam correction (2026-07-13):** names live on **`runs.display_name` in MinimaDb**
> (`setRunName`), *not* the legacy JSONL `SessionManager` (read-only at runtime). And the
> footer's `ctx N%` already existed and was real — B1.2's work was restoring it on resume.

| # | Step | Verify |
|---|---|---|
| B1.1 | `--resume <name-or-id>`: `MinimaDb.findRunByName` (exact name → case-insensitive → run-id → id-prefix ≥4 chars; most-recent wins; name outranks id-prefix) resolved **before** `startRun` (typo → no stray run row); rehydrated in `main()` before first render (`initialResume` prop), lineage via `setRunParent`; unknown target lists near matches (`searchRuns`) and exits 2 — never silently starts fresh. `/rename` = alias of `/name` (persists via `setRunName`); empty-arg shows the current name | rename/resume round-trip tests at the DB layer + parseArgs tests |
| B1.2 | Footer stats survive resume: shared pure `footerStatsFromMessages` (`src/tui/footer.ts`) feeds `↑ ↓ · ctx%` from the post-turn path AND both resume paths (`/resume` + `--resume`) — real values because U1.1 made rehydrate carry usage. `chatFromMessages`/`resumeNotice` (`src/tui/resume.ts`) shared by both restore paths | footer.test.ts + PTY shots **both renderers** with non-zero restored values |

**Exit gate:** tests + 2 shots committed. ✅

### B2 — Plan↔Build primary agents on Shift+Tab *(borrow #5 · M)* — MUB-135

> **Amended (2026-07-13):** cycle key is **Shift+Tab** (Tab stays composer autocomplete); the
> thinking-level cycle that lived on Shift+Tab moved to **Ctrl+E**. The badge shows **PLAN
> only** — build leaves the shared Phase-0 slot free for Track A guard flags (the old row-1
> `[PLAN]` StatusBar segment was removed; the badge replaces it). Plan-mode "ask"
> **outranks** an `allowAlways` grant by design (the prompt is prefixed
> "plan mode — asks every time:" so the recurring ask is self-explaining).

| # | Step | Verify |
|---|---|---|
| B2.1 | Two primary agents as **PolicyBundles** (`src/agent/modes.ts`): Plan = write/edit/apply_patch/bash → **ask** (was hard deny — decided change), catch-all allow first (last-match-wins); Build = catch-all allow → normal permission flow. Mode = external store (badge_slot pattern); `beforeToolCall` = `makeModeGatedBeforeToolCall` in `src/tui/permissions.ts` (deny → block w/ policy reason · ask → `GuardEvent(mode-ask)` + forced prompt · allow → `checkPermission`) | policy resolution + forcePrompt + factory tests |
| B2.2 | Footer badge `[PLAN]` in the Phase-0 slot (build = empty); Shift+Tab cycles; `/plan` = same toggle | PTY shots of the toggle, both renderers |
| B2.3 | Escape-hatch hint appended per-turn in `promptRouted` (mode-conditional, restored in `finally`; "" in build → headless unchanged) | prompt snapshot test (`PLAN_ESCAPE_HATCH` verbatim) |

**Exit gate:** scripted run: `edit` in Plan mode → ask; shots committed. ✅

### B3 — Git-shadow checkpoints *(decided design · L)* — MUB-136

> **Landed (2026-07-13):** module `src/session/checkpoint.ts` + migration v9 `checkpoints`
> table. The mapping ledger is keyed by **replay-space prompt ordinal** (count of persisted
> lead user events — the sink flushes at turn_end, so mid-turn the triggering prompt isn't
> counted: ordinal = "worktree before this prompt"), NOT JSONL entry ids (that store is
> runtime-dead). Ref scheme `refs/minima/ckpt/<runId>/<seq>-<id>` (zero-padded seq → lexical
> = chronological). The per-run GIT_INDEX_FILE is **reused** (warm stat cache → `add -A`
> near-instant); snapshots dedupe on tree sha (read-only turns cost no refs); commit-tree
> gets explicit minima@local identity (hosts without derivable email). **Restore is
> full-tree byte-identical + a `safety` snapshot first** (decided: /undo is itself
> undoable; parallel user edits land in the safety checkpoint). Restore = `diff-tree
> --no-renames -z target now` → delete created-since paths (files/symlinks only — never
> directories, protects gitlinks; empty parents pruned) → batch `read-tree` +
> `checkout-index -f -z --stdin` for the rest (modes/symlinks preserved, gitlinks skipped,
> tracked files not in the diff never re-mtimed). Caveat documented: user-created untracked
> files between checkpoints die when restoring past their creation — inherent; the safety
> snapshot holds them. Trigger = `makeCheckpointHook` armed per prompt dispatch, fires on
> the first of write/edit/apply_patch/bash/**task** (children are hook-free — a task call
> is a write path), registered permission-gate → checkpoint → GT done-gate. Headless `-p`
> arms once. `/ckpt` lists · `/ckpt gc` prunes (keep current + 5 recent runs). Exit-gate
> deviation: no PTY shot (no visible UX beyond /ckpt text) — the ledger-proof tests stand in.

| # | Step | Verify |
|---|---|---|
| B3.1 | Snapshot on first mutating tool call per prompt: reused per-run `GIT_INDEX_FILE` → `add -A` → `write-tree` (dedupe) → `commit-tree` → `refs/minima/ckpt/<runId>/<seq>-<id>`. User's index/worktree never touched; `.gitignore`d files excluded by design | `checkpoint.test.ts`: snapshot → mutate → restore byte-identical (modified/created/deleted/mode/ignored), porcelain unchanged, safety-undoes-the-undo round trip ✅ |
| B3.2 | Map ref ↔ run ↔ prompt ordinal ↔ step id (v9 `checkpoints` row; step from `getInProgressStep` when GT on) | mapping + step-attribution tests ✅ |
| B3.3 | Non-git dir → checkpoints off with a one-time one-line notice; `/ckpt gc` prunes old runs' refs (batched `update-ref --stdin -z`) + rows + warm indexes | graceful-degrade + GC tests ✅ |

**Exit gate:** round-trip suite green in a scratch repo. ✅

### B4 — `/undo`: revert + re-prompt *(borrow #6 · M)* — MUB-139

> **Landed (2026-07-13):** the `store.ts:102` reference was stale (JSONL store is
> runtime-dead) — the branch model is **rewind markers on the SQLite events spine, same
> run**: `/undo` appends a `rewind` event (`{keep_prompts}` in replay space) and
> `rehydrateRun` learned replay-with-truncation, so /resume replays the rewound timeline
> while the abandoned turns stay in the log (append-only; still rewindable-to). Meter rows
> and promptsRun stay full — the spend happened (feedback truth). Live in-memory truncation
> maps by **distance-from-end** (`truncateLastPrompts`) — /compact can rewrite old turns,
> but live and replay space share their tail. Files restore through B3's `restore()`
> (safety snapshot inside — /undo is undoable). Composer prefill = new TextInput
> `initialValue` + key-nonce remount. Stacking = an in-memory cursor
> (`beforeCreated` on `latestCheckpoint`, kind='turn' — safety rows are never undo
> targets), reset on the next prompt. The old `/undo` stub (`git checkout --` with no
> pathspec — a git usage error that reverted nothing while claiming success) is replaced.
> v1 scope: /undo reaches only the CURRENT session's checkpoints — after `--resume` the
> ordinal spaces of the old run's checkpoints and the new run's events differ; lineage
> walk-back is deferred. Shot infra: `--provider-url` CLI flag (OpenAI-compatible base URL
> for a custom `--provider` — ollama/vLLM/local mocks) landed to drive a real mutating
> turn against a local mock server with zero spend.

| # | Step | Verify |
|---|---|---|
| B4.1 | `/undo` = B3 checkpoint restore (safety snapshot inside) + rewind marker on the events spine + in-memory truncation + composer prefilled with the undone prompt | rewind.test.ts (marker round-trip, stacked markers, meter-stays-full) + PTY shot: real mock-driven edit turn → `/undo` → file restored on disk, prompt prefilled ✅ |
| B4.2 | Stacking: repeated `/undo` walks back through turn checkpoints | walk-back ×2 seam test (`latestCheckpoint` beforeCreated) ✅ |

**Exit gate:** tests + PTY shot of the prefilled composer. ✅ (`b4-undo-prefill-fullscreen.png`)

### B5 — `/rewind` *(borrow #7 · M)* — MUB-142

> **Landed (2026-07-13):** "over the JSONL tree" corrected — turns are the transcript's
> real user prompts (slash echoes excluded, U2's anchor rule) mapped to replay space by
> distance-from-end (B4's compact-safe rule). Fullscreen: overlay picker on the U2 chassis
> (j/k · **[c]onvo · [f]iles · [b]oth/⏎** · esc, ✓ marks code-restorable turns); inline or
> narrow: `/rewind` prints the numbered list and `/rewind <n> [convo|code|both]` (default
> both) executes directly. Conversation mode = B4's rewind marker + tail truncation +
> prefill. **Code mode targets the checkpoint with the smallest `prompt_ordinal ≥ keep`**
> (`earliestCheckpointAtOrAfter`) — snapshots capture the worktree BEFORE a mutating
> prompt's changes, so "files as of prompt j's submission" lives in prompt j's own
> snapshot (if it mutated) or the next mutating prompt's; no such checkpoint = files
> already match (no-op notice). Restores go through B3's `restore()` (safety snapshot —
> every rewind is undoable).
>
> **Note (2026-07-14):** the picker stays a transient OVERLAY (the original overpaint
> chassis on `tocPanelGeometry`) while ToC/GT docked — pick-one-and-act modality fits an
> overlay. It gained the `panelCapture` fix: the composer now suspends while it is open
> (previously arrows/Enter also hit the prompt box — the U3/B5 key leak).

| # | Step | Verify |
|---|---|---|
| B5.1 | Turn picker over the live transcript's prompt anchors (U2 rule); overlay in fullscreen, numbered one-shot list inline | picker + list PTY shots, both renderers ✅ |
| B5.2 | Three restore modes: **conversation only** (rewind marker — non-destructive, replay agrees with live truncation), **code only** (checkpoint restore, conversation intact), **both** | one seam test per mode (`rewind_picker.test.ts`) ✅ |

**Exit gate:** 3 mode tests + picker shot, both renderers. ✅ (`b5-rewind-picker-fullscreen.png`, `b5-rewind-inline.png`)

### B6 — Writer/Reviewer two-session workflow *(stretch · S)* — *new Linear issue*

Documented workflow + `--review <session>` convenience flag: Writer on the cheapest routed
model, Reviewer on a stronger model in fresh context.
**Exit gate:** doc + smoke test. Cut first if the schedule slips.

---

## 5b. Minima-unique changes — U-phases *(SWE-B · these are not borrows)*

> Unlike the A/B phases (mechanisms proven in other harnesses), these are **Minima-original
> UX** — only the panel *visual* nods to OpenCode's `Ctrl+X B` sidebar. ~~Decided design:
> **overlay** panel — never reflows the characters-per-line underneath~~ **REVISED
> 2026-07-14 (manual-testing feedback): the ToC/GT panels are a DOCKED right sidebar** —
> the chat region splits row-wise into a transcript column (`sidebarGeometry.contentCols`
> feeds `getScrollableMessages`/`MessageRow`/`offsetForMessage`) beside an in-flow sidebar;
> the composer/status/footer stay full-width. The sidebar is **persistent with a focus
> toggle**: opens focused (bright border, ↑↓/⏎ navigate), Esc hands the keyboard back to the
> composer with the panel still docked and live-updating (border dims), Ctrl+T/Ctrl+G
> refocus/swap, the panel's own chord closes it while focused. One derived `panelCapture`
> feeds BOTH the global-handler guard list and the composer's `suspended` — this kills the
> key-leak class where a panel captured one but not the other (arrows scrubbed history,
> Enter could submit mid-navigation). The **rewind picker stays a transient overlay** (the
> original overpaint chassis). Still **fullscreen renderer only in v1** (inline
> `MINIMA_TUI_INLINE` gets the same content as a one-shot text block on the same shortcut) ·
> direct shortcuts **Ctrl+T** (Table of Contents) and **Ctrl+G** (GT Plan Overview).
> Sequenced right after B2 — the section/anchor model built in U2 is reused by B5's turn
> picker, so this ordering *saves* work, not just reprioritizes it.

### U1 — Session usage ledger *(S)* — MUB-138

**RESCOPED (2026-07-13):** per-turn usage is **already persisted** — `DbSink` writes
`{model, stop_reason, usage:{input, output, cache_read, cache_write, cost_total}}` into
`events.payload` on every assistant `message_end` (SQLite spine). The session JSONL layer is
legacy/read-only at runtime (zero `append` callers) and receives **no changes**. No schema
migration: roll-up on read.

| # | Step | Verify |
|---|---|---|
| U1.1 | Preserve + restore: `rehydrateRun` reads `payload.usage`/`stop_reason` back into `AssistantMessage` so a resumed session carries the same in-memory usage as a live one (cost: `total` only — components aren't persisted; legacy rows rehydrate zeroed, never NaN) | round-trip test: DbSink write → rehydrate → usage equality |
| U1.2 | Section model as pure `src/session/sections.ts` over the agent's `Message[]` (message-index ranges): `computeSections() → {sections: [{index, title, startMsgIdx, endMsgIdx, usage, cumulative}], totals}` — the U2 ToC contract (per-section $ + cumulative $ + total tokens). **Child-agent usage excluded in v1** (children's messages never enter the lead conversation; their spend stays on `routing_decisions.agent_id` + the run meter). Known pre-existing wart: rehydrated meter totals include child rows, the live meter doesn't — reconcile decision deferred to U2 | aggregation tests on a fixture message list, incl. price-catalog math |

**Exit gate:** fixture session yields correct per-section and cumulative `{tokens, $}`.

### U2 — Table of Contents sidebar, `Ctrl+T` *(L)* — MUB-140

> **Landed (2026-07-13):** the overpaint spike succeeded — Ink `position="absolute"` +
> full-region height (pins Yoga's static-position ambiguity under `flex-end`) + every
> interior row painting padded columns closed by the right border glyph (defeats Ink's
> trailing-whitespace trim). No fallback needed. Anchors are **ChatMessage indices** (not
> JSONL entry ids — the render list is the jump space); usage joins the U1 ledger **by
> prompt ordinal** (slash echoes / synthetic sections exist on only one side, so raw
> index joins would drift). Ctrl+T works mid-run (read-only, like PgUp); TextInput gets a
> `suspended` prop (stays mounted → draft survives); below 60 cols the fullscreen path
> degrades to the same one-shot text block as inline. Known cosmetic: ambiguous-width
> glyphs (⚙) can trigger a truncation ellipsis inside a panel row.
>
> **Revised (2026-07-14):** the ToC panel is now DOCKED (see the 5b preamble) — in-flow
> beside the transcript, so the absolute-overpaint chassis and its Yoga static-position
> pin remain only for the B5 rewind picker. The U2.1 no-reflow invariant is retired:
> `sidebarGeometry` deliberately narrows the transcript to `contentCols` while docked
> (closed → `contentCols === cols`, byte-identical). Rows pad by display width
> (`padDisplay`) — the raw `padEnd` wide-glyph bleed is fixed. Focus model + `panelCapture`
> input routing per the preamble; while unfocused the composer types normally and Esc/^C
> abort work as if no sidebar were open (previously an open panel swallowed them).

| # | Step | Verify |
|---|---|---|
| U2.1 | ~~Overlay chassis~~ **Docked chassis (2026-07-14)**: `sidebarGeometry` (width `min(40, cols−30)`, `contentCols = cols − sidebarWidth`, null below 60 cols) + `clipPanelLines` + `TocPanel` in-flow column with focus toggle; `tocPanelGeometry` survives for the B5 rewind overlay | `layout.test.ts`: geometry caps/null-gates, partition invariant (`sidebarWidth + contentCols === cols`), narrowed-window Σ≤budget (no-reflow invariant retired 2026-07-14) ✅ |
| U2.2 | `src/tui/toc.ts`: sections per user prompt (slash echoes attach to the previous section), children = result · tools aggregate (`⚙ N tools (bash×2…)`, error flag) · plan created/updated/finalized (todowrite `(x/y done)` parse); per-section `$ · tok`; Σ footer labeled **lead agent** (child spend excluded, per U1) | `toc.test.ts` fixture render tests ✅ |
| U2.3 | ↑/↓ (j/k) cursor over titles; **Enter jumps** via pure `offsetForMessage` (prefix-sum over `computeMsgHeight`, clamped; last page → pinned); Esc/`Ctrl+T` closes; global hook guards on `tocOpen` | `offsetForMessage` round-trip/clamp tests ✅ |
| U2.4 | Inline fallback: `Ctrl+T` appends the ToC as a one-shot `toc:` tool message (same content) | PTY shot, inline renderer ✅ |

**Exit gate:** PTY shots — sidebar open in fullscreen, text block in inline; jump test green. ✅

### U3 — GT Plan Overview sidebar, `Ctrl+G` *(M)* — MUB-141

Same chassis as U2, different content + shortcut; gated by `MINIMA_TUI_GROUND_TRUTH`.

> **Landed (2026-07-13):** `Ctrl+G` is SHARED with Track A's gate-answer modal — an
> unanswered 🔴 block (and not busy) wins the chord; any other time it opens the overview
> (answering/dismissing the gate hands the chord back). U3.2's premise was corrected: nothing
> attributed **cost** to steps (file_changes attributes writes; `routing_decisions` had no
> step_id) — attribution is created by **migration v8** `routing_decisions.step_id`, stamped
> at decision-write time from `getInProgressStep` (`runtime.ts` — Track A shared surface,
> flagged for SWE-A review; feedback upserts COALESCE so they never clear the stamp). Steps
> with no stamped rung render `—`, never $0. Panel rows clip/pad by **display width**
> (`string-width`) — code-point math under-counts the double-emoji row leads (⬜🟦✅ + tier).
> Known cosmetic: the pyte shot emulator misdraws a stale border cell on some emoji rows
> (same class as U2's ⚙ note); Ink's emitted rows are width-exact (raw-PTY verified).
> `stepCardLines` (gt_overview.ts) is the shared per-step card J1's `/why` view builds on.
>
> **Revised (2026-07-14):** docked like the ToC (same `sidebarGeometry` chassis + focus
> model; Ctrl+T↔Ctrl+G swap between the two while focused). This fixed the U3/B5 key leak:
> the composer's `suspended` only covered `tocOpen`, so with the GT panel or rewind picker
> open every key ALSO hit the composer (history scrub, draft growth, Enter could submit) —
> now one `panelCapture` expression drives both the guard list and `suspended`. The docked
> overview live-updates (memo keyed on the planStrip/gtBehavior ledger-refresh signals),
> replacing the open-snapshot contract.

| # | Step | Verify |
|---|---|---|
| U3.1 | Content from the ledger: plan title · `step X/N` · per-step status (⬜/🟦/✅ + 🟢/🟡/🔴 tier via `gateVerdictFor`, same reduction as /why) · `verify` cmd · DRIFT flag · gates | `gt_overview.test.ts` render tests on a seeded ledger ✅ |
| U3.2 | **Per-step cost**: v8 `routing_decisions.step_id` stamp at decision time; `stepCosts` aggregates realized $ per step + plan total (footer) | aggregation tests incl. legacy-null → `—` + upsert-preserves-stamp ✅ |
| U3.3 | Cursor + Enter opens the step's detail card (`stepCardLines` — becomes J1's `/why` per-step view); Esc back; inline/narrow → one-shot text block | card tests + PTY shots (panel + card) ✅ |

**Exit gate:** seeded-plan shot with statuses + prices; flag-off notice (`Ctrl+G` → "Ground-Truth is OFF"). ✅

---

## 6. Joint phase

### J1 — `/why` + whole-plan verification subagent + E2E demo *(GT stage 8 + borrow #9 · L)* — MUB-126, MUB-127

Requires: A4 (tiers), A7 (stamping), B1 (sessions), B3 (checkpoints).

> **Landed (2026-07-14):** `/why <n>` opens step n's detail card — the SAME `stepCardLines`
> component as the U3 panel (one card, two surfaces), now with per-gate **evidence lines**
> (`red→green vs the captured baseline` · an honest `pre-satisfied` label when a check was
> green from the start) and a **plan gates** section in the `/why` report (closure
> milestones and the refutation verdict were previously invisible — no step_id). `/verify`
> runs the **refutation subagent** (`src/minima/plan_refute.ts`) through the same spawn
> seam as council research: the child gets the ledger's own story and READ-ONLY orders to
> disprove it (re-run every check, hunt weak/deleted tests, contradicting drift). Verdict
> parsing is FAIL-CLOSED (missing/garbled → refuted; aborted → nothing recorded); the gate
> is a plan-level `milestone` with `verified_by:"judge"` — capped at 🟡 (an agent's opinion
> never outranks a deterministic check), 🔴 when refuted — carrying the run's latest rec_id
> so `stampGroundedOutcome` feeds `gt_outcome` (deterministic red still wins the identity
> join). Demo correction: a BLOCKED call never reaches the doom-loop ring (the loop
> short-circuits before afterToolCall — hammering the gate is A2 N-strike territory), so
> the journey's spiral is an executed failing read, exactly what A3 watches.

| # | Step | Verify |
|---|---|---|
| J1.1 | M8.1 `/why`: per-step verification view — `/why <n>` card (shared `stepCardLines`) with gates rows, baseline, red→green evidence; plan-level gates in the report | gt_overview evidence tests + `j1-why-card-fullscreen.png` ✅ |
| J1.2 | **Verification subagent**: whole-plan refutation pass via the spawn seam (`/verify`); fail-closed verdict → judge-verified milestone gate feeding `gt_outcome` | `plan_refute.test.ts` (7 scripted runs incl. red-wins + abort/throw fail-closed) ✅ |
| J1.3 | M8.2 E2E demo: scripted acceptance run — plan → blocked done → doom-loop (nudge → stop gate) → fix → red→green → gate → plan closes → `/why` → refutation → grounded stamps on both rungs | `j1-e2e.test.ts` — the demo IS a bun test ✅ |

**Exit gate = plan `done`.** ✅ J1 complete — remaining open: A5 (Track A) and B6 (stretch, cut-first).

---

## 7. Dependency graph & suggested calendar

```
        week 1        week 2          week 3           week 4          week 5         week 6
SWE-A   [P0]──[A1]────[A2]───[A3]────[A4]───[A5]──────[A6]───[A7]──(slack: reviews, J1 prep)─┐
SWE-B   [P0]──[B1]─[B2]──[U1]─[U2────────]─[U3]───────[B3────────────]──[B4]───[B5]──────────┤
                 ▲sync A2/B2            ▲sync A4/U3,B4 tiers↔UX                     (B6 cut) └─[J1]
Hard deps:  A2→A1 · A4→A2,A3 · A5→A4 · A6→P0 · A7→A2 · B2→P0 · U2→U1 · U3→U1 (tier icons →A4)
            B4→B3 · B5→B3,B4 (+U2's anchor model) · J1→A4,A7,B1,B3,U3 (shared /why card)
```

---

## 8. MUB mapping and new issues

**Existing issues re-mapped** (GT doc's status table remains the per-MP reference):

| Phase | Linear |
|---|---|
| A1 | MUB-111, MUB-112, MUB-113 |
| A2 | MUB-114, MUB-115, MUB-116 |
| A4 | MUB-120, MUB-121, MUB-122 |
| A5 | MUB-117, MUB-118, MUB-119 |
| A7 | MUB-123, MUB-124, MUB-125 |
| J1 | MUB-126, MUB-127 |

**New issues (created 2026-07-13, labeled `Track A` / `Track B`; U-issues also `Minima-unique`):**

| Phase | Linear |
|---|---|
| P0 interface contract | MUB-129 *(both track labels)* |
| A3 doom_loop · steps cap | MUB-130 · MUB-131 |
| A6 allowlist + task perms + lint · poka-yoke | MUB-132 · MUB-133 |
| B1 · B2 · B3 · B4 · B5 · B6 | MUB-134 · MUB-135 · MUB-136 · MUB-139 · MUB-142 · MUB-137 |
| U1 · U2 · U3 | MUB-138 · MUB-140 · MUB-141 |

Blocking relations mirror §7's hard deps: P0 (MUB-129) blocks A3/A6a/B2 · B3 → B4 → B5 ·
U1 → U2/U3.

---

## 9. Live status

| Phase | Owner | Size | Status |
|---|---|---|---|
| P0 interface contract | both | S | ✅ a810739 |
| A1 verify primitive | A | M | ✅ |
| A2 stop hook + block-done | A | M | ✅ |
| A3 doom_loop + steps cap | A | M | ✅ |
| A4 confidence tiers + failure kinds | A | M | ✅ |
| A5 trust the check | A | M | ⬜ |
| A6 allowlist + task perms + poka-yoke | A | M | ✅ |
| A7 learning loop | A | M | ✅ |
| B1 named sessions + status line | B | S | ✅ |
| B2 Plan↔Build on Shift+Tab | B | M | ✅ |
| B3 git-shadow checkpoints | B | L | ✅ |
| B4 /undo | B | M | ✅ |
| B5 /rewind | B | M | ✅ |
| U1 session usage ledger *(Minima-unique)* | B | S | ✅ (rescoped: SQLite + in-memory) |
| U2 ToC sidebar `Ctrl+T` *(Minima-unique)* | B | L | ✅ |
| U3 GT Plan Overview `Ctrl+G` *(Minima-unique)* | B | M | ✅ |
| B6 Writer/Reviewer (stretch — first cut) | B | S | ⬜ |
| J1 /why + subagent + E2E demo | both | L | ✅ |

**▲sync A4/U3,B4 (tiers↔UX) checkpoint — LANDED**: `feature/UX_improvements_track_A` (A1–A4 on
the GT lineage) and `feat/BP-UX-TrackB` (U1/B1/B2/U2 on P0) merged into `feat/BP-UX`.
Reconciliations: plan mode = B2 PolicyBundle ask-first for write/edit/bash/apply_patch, with
Track A's hard blocks kept for the tools an ask cannot make safe (`task` always — hook-free
children are a write bypass; `todowrite` under GT — approving one runs `verify` as shell);
`/plan` keeps the GT council subcommands (start·status·finalize·cancel) behind
MINIMA_TUI_GROUND_TRUTH with the mode itself in the B2 store (Shift+Tab exit tears the council
session down like `/plan off`); permission hooks compose via `addBeforeToolCall` — mode gate
first, GT done-gate second (first block wins).
