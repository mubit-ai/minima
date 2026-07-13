# Big Plan — Master Execution Plan

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

### B3 — Git-shadow checkpoints *(decided design · L)* — *new Linear issue*

| # | Step | Verify |
|---|---|---|
| B3.1 | Snapshot on first mutating tool call per turn: `git add -A` under a **temporary `GIT_INDEX_FILE`** → `write-tree` → `commit-tree` → ref `refs/minima/ckpt/<sessionId>/<entryId>`. User's index/worktree **never touched**. Note: `.gitignore`d files are excluded by design — document it | temp-repo test: snapshot → mutate → restore is byte-identical, incl. untracked files |
| B3.2 | Map ref ↔ JSONL entry id ↔ step id (GT already attributes writes to steps) | mapping test |
| B3.3 | Non-git dir → checkpoints off with a one-line notice; GC command prunes old refs | graceful-degrade test |

**Exit gate:** round-trip suite green in a scratch repo.

### B4 — `/undo`: revert + re-prompt *(borrow #6 · M)* — *new Linear issue*

| # | Step | Verify |
|---|---|---|
| B4.1 | `/undo` = restore files from last checkpoint **+ branch the session tree** (`store.ts:102` already supports branching — undo is a branch, not a destructive drop) **+ prefill composer with the original user message** for editing | scripted: edit → `/undo` → files restored, prompt prefilled |
| B4.2 | Stacking: repeated `/undo` walks back through checkpoint refs | stacked ×2 test |

**Exit gate:** tests + PTY shot of the prefilled composer.

### B5 — `/rewind` *(borrow #7 · M)* — *new Linear issue*

| # | Step | Verify |
|---|---|---|
| B5.1 | Turn picker over the JSONL tree (reuses U2's section/anchor model) | picker renders in PTY shot |
| B5.2 | Three restore modes: **conversation only** (branch from entryId — non-destructive), **code only** (checkpoint restore), **both** | one test per mode |

**Exit gate:** 3 mode tests + picker shot, both renderers.

### B6 — Writer/Reviewer two-session workflow *(stretch · S)* — *new Linear issue*

Documented workflow + `--review <session>` convenience flag: Writer on the cheapest routed
model, Reviewer on a stronger model in fresh context.
**Exit gate:** doc + smoke test. Cut first if the schedule slips.

---

## 5b. Minima-unique changes — U-phases *(SWE-B · these are not borrows)*

> Unlike the A/B phases (mechanisms proven in other harnesses), these are **Minima-original
> UX** — only the panel *visual* nods to OpenCode's `Ctrl+X B` sidebar. Decided design:
> **overlay** panel — draws over the transcript and prompt at a fixed width, **never reflows
> the characters-per-line underneath** · **fullscreen renderer only in v1** (inline
> `MINIMA_TUI_INLINE` gets the same content as a one-shot text block on the same shortcut) ·
> direct shortcuts **Ctrl+T** (Table of Contents) and **Ctrl+G** (GT Plan Overview); Esc or
> the same key closes. Sequenced right after B2 — the section/anchor model built in U2 is
> reused by B5's turn picker, so this ordering *saves* work, not just reprioritizes it.

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

| # | Step | Verify |
|---|---|---|
| U2.1 | Overlay chassis: `tocPanelGeometry` (width `min(40, cols−30)`, full region height, null below 60 cols) + `clipPanelLines` + `TocPanel` absolute overpaint — out-of-flow, so no reflow and the invariant is untouched | `layout.test.ts`: geometry caps/null-gates, clip exactness, no-reflow invariant ✅ |
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

| # | Step | Verify |
|---|---|---|
| J1.1 | M8.1 `/why`: per-step verification view — gates rows, baseline, red→green evidence | view test + PTY shot |
| J1.2 | **Verification subagent**: whole-plan refutation pass via the `task` tool on a stronger model; outcome feeds `gt_outcome` | scripted refutation run |
| J1.3 | M8.2 E2E demo: scripted acceptance run — plan → blocked done → doom-loop 🟡 → fix → red→green → gate → `/why` | the demo **is** a bun test; shot series committed |

**Exit gate = plan `done`.**

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
| A6 allowlist + task perms + poka-yoke | A | M | ⬜ |
| A7 learning loop | A | M | ⬜ |
| B1 named sessions + status line | B | S | ✅ |
| B2 Plan↔Build on Shift+Tab | B | M | ✅ |
| B3 git-shadow checkpoints | B | L | ⬜ |
| B4 /undo | B | M | ⬜ |
| B5 /rewind | B | M | ⬜ |
| U1 session usage ledger *(Minima-unique)* | B | S | ✅ (rescoped: SQLite + in-memory) |
| U2 ToC sidebar `Ctrl+T` *(Minima-unique)* | B | L | ✅ |
| U3 GT Plan Overview `Ctrl+G` *(Minima-unique)* | B | M | ✅ |
| B6 Writer/Reviewer (stretch — first cut) | B | S | ⬜ |
| J1 /why + subagent + E2E demo | both | L | ⬜ |

**▲sync A4/U3,B4 (tiers↔UX) checkpoint — LANDED**: `feature/UX_improvements_track_A` (A1–A4 on
the GT lineage) and `feat/BP-UX-TrackB` (U1/B1/B2/U2 on P0) merged into `feat/BP-UX`.
Reconciliations: plan mode = B2 PolicyBundle ask-first for write/edit/bash/apply_patch, with
Track A's hard blocks kept for the tools an ask cannot make safe (`task` always — hook-free
children are a write bypass; `todowrite` under GT — approving one runs `verify` as shell);
`/plan` keeps the GT council subcommands (start·status·finalize·cancel) behind
MINIMA_TUI_GROUND_TRUTH with the mode itself in the B2 store (Shift+Tab exit tears the council
session down like `/plan off`); permission hooks compose via `addBeforeToolCall` — mode gate
first, GT done-gate second (first block wins).
