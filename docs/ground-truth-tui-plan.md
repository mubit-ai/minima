# Minima Ground-Truth — TUI/UX Implementation Plan

**Status:** draft v1 (2026-07-07). **Scope:** the *UX-first vertical slice* of the Ground-Truth
Core — the parts a CLI user can **watch** and **steer** — riding a **thin** ledger. Companion to
the (forthcoming) `ground-truth-architecture.md` (the *what/why* + full GT-0→GT-8 spec) and
`ground-truth-implementation-plan.md` (the full milestone ladder). Where they disagree with this
doc on UX shape, this doc wins; where they disagree on schema/enforcement internals, they win.

Paths are under `packages/tui/` (the **TypeScript/Bun Ink** app — the *running* harness) unless
noted. The Python `src/minima_harness/` modules and `docs/goals-feature-plan.md` are the origin
and are **superseded** by this plan (see §2). Sizes assume one engineer; every phase is
independently shippable behind a flag.

---

## 0. North star & the pain it kills

> **One embedded SQLite ledger is the ground truth for what the agent is doing, what it changed,
> what it's allowed to do, and how well it did — and the terminal always shows a live, honest
> projection of it that you can grab and redirect without scrolling.**

The five verbatim pains and the UX guarantee each one gets:

| # | Pain (verbatim) | UX guarantee | Primary surface |
|---|---|---|---|
| 1 | Hard to follow what the CLI agent is doing | **Glanceable** — current step + live action are always on screen | Always-on GT strip (§5.1) |
| 2 | Agent does the wrong task / drifts from the plan | **Drift is visible + steerable** — off-plan work is flagged the moment it happens | Strip drift state + steer lever (§5.4) |
| 3 | Hard to tell when the plan has gone wrong | **Objective, not vibes** — drift/gate outcomes come from the ledger, never a fabricated score | Strip + `/why` overlay (§5.2) |
| 4 | You must scroll all the way up to see the plan | **No-scroll** — the plan is one keystroke away and its summary is pinned to the footer | GT strip + plan overlay (`ctrl+g`) |
| 5 | No ground truth a user can watch or use to redirect agent(s) | **Watchable + three redirect levers** | Ledger projection + steer / interrupt / approve (§5.4) |

Design theses inherited from the spec (unchanged): **P1** state in the DB, projections in context;
**P2** enforcement in the dispatcher, guidance in the prompt; **P3** every work unit emits a
routing observation. UX theses added by this plan are in §3.

---

## 1. Locked decisions (from sign-off)

1. **UX-first slice + thin ledger.** Build the *watchable/steerable* rungs first; carry only the
   minimum schema they need. Heavier rungs (GT-3 gates engine, GT-4 policy, GT-5 audit, GT-7/8
   routing/pinning) are named dependencies with stubs, not built here.
2. **Surface = always-on strip + overlay stack.** A compact persistent plan/status strip glued
   above the prompt, plus a keypress-opened overlay stack (plan / why / diff / approve).
3. **Three redirect levers**, all enforced at dispatch/turn boundary (P2): **steer** (inject
   guidance), **hard-interrupt** (abort, closes #83), **plan-approval** (gate before execute).
   `$EDITOR`-edit of the plan is deferred to a later phase.
4. **GT subsumes `/goals`** on the TS Ink track (§2).
5. **Enforcement default = `observe`, configurable** (§8.7) — reuses the existing
   `shadow|warn|enforce` vocabulary already in `budgets.mode` (`db/minima_db.ts:109`).

---

## 2. Relationship to `/goals` + the migration invariant

Grounding found two frontends: the **shipping TS Ink app** (`packages/tui/src`, `bun:sqlite`,
schema **v2** today) and an **older Python TUI** (`src/minima_harness/tui`) that
`docs/goals-feature-plan.md` targets. GT's ledger, "schema v3 via ordered migrations", and "every
row is a routing feature" all point at the TS track, and the DB migration mechanism only exists
there.

**Decision:** GT **subsumes** `/goals`. The `Goal`/`GoalTask` model (`content`, `active_form`,
`status`, `est_cost_usd`, `actual_cost_usd`, `task_type`) is a *strict subset* of GT's
`plans`/`plan_steps` (§4) — so we fold it in rather than shipping a second, divergent tracker. The
Python `/goals` plan is retired; its research (Claude Code TodoWrite, Cline Focus-Chain,
Windsurf plan.md, cost-as-budget) is preserved as design input here.

**Migration invariant (hard rule).** Migrations are an *append-only, ordered* `MIGRATIONS:
string[][]` at `db/minima_db.ts:29–130`; `migrate()` (`:200–216`) applies each not-yet-applied
index in one transaction and bumps `schema_meta.version`. Current version is **2**.

> Schema v3 is **one new array appended at `db/minima_db.ts:130`** — `migrate()` auto-applies index
> 2 and sets version to 3. **Never edit an already-shipped migration index.** Additive columns use
> `ALTER TABLE … ADD COLUMN` inside the v3 array (the v2 migration already does this for
> `routing_decisions`). This is the §13.1 blocker: v3 shapes must be signed off before the batch
> merges.

---

## 3. UX principles (derived from the pains + prior art)

1. **Glanceable-by-default, deep-on-demand.** The strip answers "what/where/is-it-okay" in ≤3 rows;
   everything else is progressive disclosure behind a keystroke (Claude Code hides the plan behind
   plan-mode; Aider hides reasoning behind `/ask`). Pain 1, 4.
2. **Drift is a first-class visual state, not an inference.** The strip has a dedicated `⚠ DRIFT`
   state driven by a ledger fact (a write to a file no active step claims, or the model editing
   while no step is `in_progress`). Never a model self-report. Pain 2, 3.
3. **No fabricated quality.** Outcomes are gate labels (`approved|rejected|off-plan|failed`), never
   a made-up 0–1 score — mirrors the existing honesty fix (`routing_decisions.judged=0` on
   abstain, `runtime.ts` feedback discipline). Pain 3.
4. **Redirect must be cheap and always reachable.** One key to steer, one to abort, one to approve —
   available from the strip without opening anything. CLI users abandon tools that make correction
   expensive. Pain 5.
5. **Terminal-safe or it doesn't ship.** Every added row is accounted in `footerHeight` /
   `chatRegionHeight` / `streamReserved`, or it trips the Ink overflow-garble class (§8.1). Works in
   both fullscreen and inline renderers; degrades below 40×10 to a resize notice (existing behavior).
6. **Low friction by default.** Default posture is *observe + warn*, not *block everything* — the
   #1 complaint about approval-mode agents is gate fatigue. Gates escalate only for risky ops or by
   opt-in (§8.7).
7. **Keyboard-first, discoverable.** Every lever has a hint row (the footer already teaches
   `ctrl+l / ctrl+r / esc`); new keys join it. No hidden verbs.
8. **Non-destructive steering is the headline.** The single most-cited unmet need across every tool
   surveyed is redirecting a *running* agent without discarding its work — existing `Esc` is
   destructive and typed corrections merely queue (CC #30492, #36326). Our steer lever pauses
   softly, keeps work-so-far, applies the redirect at the next turn boundary, and echoes the
   accepted redirect into the strip so it becomes visible ground truth. Pain 5.
9. **Never break terminal-native copy/scroll/search; toggle, don't force.** The most-punished
   anti-pattern in the survey: Gemini shipped default alt-screen and reverted in a week; Anthropic
   declined it outright. We keep the scrollback-native inline renderer first-class, gate the whole
   feature behind a flag, and make verbosity a toggle (the recurring lesson — a toggle, not a fixed
   default). §8.8.

The **research/benchmarking survey (Appendix B)** — a 5-agent, cross-verified web study of Claude
Code, Codex CLI, Aider, Plandex, Cursor, Cline, Gemini CLI, Copilot CLI, Devin, Warp and others —
grounds these principles; Phase 0 turns it into a signed decision log.

---

## 4. The ground truth: thin ledger (schema v3)

Append this as the v3 element of `MIGRATIONS` (`db/minima_db.ts:130`). It is **thin** on purpose —
just enough to back the strip, `/why`, diffs, and approval. GT-3+ extends `gates`; GT-7/8 extend
provenance. Every table FKs `run_id` and can carry `rec_id` so **every row is a routing feature**
(P3), joining the existing `routing_decisions` table (`rec_id` is the cross-store join key,
`minima_db.ts:7`).

```sql
-- v3 — ground-truth plan ledger  (append at db/minima_db.ts:130; do NOT touch v1/v2 arrays)
CREATE TABLE IF NOT EXISTS plans (
  plan_id     TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft|approved|active|done|abandoned
  origin      TEXT NOT NULL DEFAULT 'agent',   -- agent|user|server(/v1/plan)|imported
  approved_by TEXT,                             -- NULL until user approves (gate); 'auto' in observe mode
  approved_ts REAL,
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_steps (
  step_id     TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id),
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  ord         INTEGER NOT NULL,                 -- order within plan
  content     TEXT NOT NULL,                    -- imperative ("Add OAuth login")
  active_form TEXT,                             -- present-continuous ("Adding OAuth login") [from /goals]
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|in_progress|done|blocked|skipped
  task_type   TEXT,                             -- feeds the router (P3)
  rec_id      TEXT,                             -- link to routing_decisions.rec_id (P3 join key)
  est_cost_usd    REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0,
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_steps_plan ON plan_steps(plan_id, ord);
CREATE TABLE IF NOT EXISTS file_changes (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  step_id      TEXT REFERENCES plan_steps(step_id),  -- the step that owned this write; NULL = off-plan (drift!)
  tool_call_id TEXT,                                  -- join to tool_calls.id
  path         TEXT NOT NULL,
  change       TEXT NOT NULL,                         -- create|modify|delete
  added        INTEGER, removed INTEGER,
  diff         TEXT,                                  -- unified diff, truncated; NULL if oversized
  ts           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_file_changes_run ON file_changes(run_id, ts);
CREATE TABLE IF NOT EXISTS gates (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs(run_id),
  step_id   TEXT REFERENCES plan_steps(step_id),
  rec_id    TEXT,
  kind      TEXT NOT NULL,                            -- plan_approval|risky_op|step_check
  origin    TEXT NOT NULL DEFAULT 'agent',            -- agent|user|policy  [spec §13.1]
  two_sided INTEGER NOT NULL DEFAULT 0,               -- [spec §13.1]
  outcome   TEXT,                                     -- approved|rejected|pending|auto|timeout
  note      TEXT,
  ts        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_gates_run ON gates(run_id, ts);
-- GT-6 (steering as a routing feature); ships in Phase 7.
CREATE TABLE IF NOT EXISTS user_signals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT, rec_id TEXT,
  kind TEXT NOT NULL,                                 -- steer|abort|reject|approve|edit
  text TEXT, ts REAL NOT NULL
);
```

**Typed writers** go on the `MinimaDb` class next to `writeDecision`/`writeToolCall`
(`minima_db.ts:230+`): `upsertPlan`, `writeStep`, `setStepStatus`, `writeFileChange`, `writeGate`,
`resolveGate`, `writeUserSignal`. Cross-process writes wrap `db.transact(...)` like `sink.ts:78`
and are **fail-open at the run boundary** (a failed ledger write marks the run `degraded`, never
breaks the turn — same discipline as the existing sink).

**DB self-protection (P2 corollary).** Ledger tables are written *only* by harness code
(hooks/sink), never by an agent tool. There is no `sql`/`plan_write` tool exposed to the model; the
model mutates the plan solely through the `plan` tool (§Phase 3), which validates and writes on the
model's behalf. This keeps a lying model from rewriting its own ground truth.

**Projection (P1).** A compact text projection (plan title, step X/N, current step, last off-plan
change, open gate) is re-injected each prompt via the proven recall pattern in
`runtime.ts:158–164` (append block to `systemPrompt`, restore in `finally` at `:312–316`), or via a
loop-native `transformContext` (`state.ts:66–71`, invoked `loop.ts:187`) for true per-turn
recompute. Keep it ≤ ~15 lines — it competes with real context.

---

## 5. UX architecture

### 5.1 The always-on GT strip

A new `GroundTruthStrip` component (sibling of `status.tsx`) mounted in the **fixed footer Box**
(`app.tsx:2302`, just above `<StatusBar>`) so it survives overlays and both renderers. Its row
count (1–3) is added to `footerHeight` (`app.tsx:1992`) — the invariant (§8.1). Hidden entirely
when no plan is active (zero rows, zero cost).

**States & wireframes** (2-row strip; `▸` = plan line, `◇` = live line):

```
── no plan ───────────────────────────────────────────────────────────────
  (strip hidden; StatusBar shows a faint "no plan · /plan to start" hint)

── executing, on track ───────────────────────────────────────────────────
 ▸ Add OAuth login                       step 3/7 · on track ✓   $0.12/~$0.40
 ◇ now: wiring /callback route → session                         sonnet·auto
 ─ ctrl+g plan · ctrl+y why · ctrl+d diffs · esc steer/abort ─────────────────

── DRIFT (off-plan write detected) ────────────────────────────────────────
 ▸ Add OAuth login                       step 3/7 · ⚠ DRIFT       $0.31/~$0.40
 ◇ now: editing billing/stripe.ts — no step claims this file     ⚠ off-plan
 ─ ctrl+g plan · ctrl+y why · a accept-drift · esc steer/abort ──────────────

── awaiting plan approval (gate) ──────────────────────────────────────────
 ▸ Plan proposed — 7 steps                ⏸ awaiting approval
 ◇ enter approve · e edit · r reject · ctrl+g review
```

The strip reuses live data the footer already computes: model/route/cost (`StatusBar` props,
`app.tsx:2309–2327`) and the `currentAction` line (`app.tsx:2304`). New data (`step 3/7`, drift,
gate) comes from the ledger projection.

### 5.2 The overlay stack

Today overlays are a **flat set of mutually-exclusive booleans** rendered as a ternary that
*replaces the prompt* (`app.tsx:2190–2298`); there is **no z-stack**. Phase 4 introduces a real
`OverlayStack` (`useState<OverlayEntry[]>`) replacing the booleans at `app.tsx:577–581` and the
`overlayOpen` derivation at `:1995`. The top entry owns input; `Esc` pops one level (the global
`useInput` early-return guard at `app.tsx:924–932` is the existing routing seam).

Overlays (each a self-contained component with its own `useInput`, modeled on `ModelPicker` /
`ConfigOverlay`):

```
── PLAN overlay (ctrl+g) ───────────────────────────────────────────────────
 Plan — Add OAuth login                                    approved · observe
 ✓ 1  Add auth config + env plumbing
 ✓ 2  Add /login route
 ◆ 3  Wire /callback → session          ← in progress   (sonnet, ~$0.05)
 ○ 4  Persist session cookie
 ○ 5  Add logout
 ⚠ off-plan: billing/stripe.ts (+14 −2)  — not claimed by any step
 ─ ↑↓ move · e edit step · s steer here · d diffs · esc close ───────────────

── WHY overlay (ctrl+y  /  /why) ────────────────────────────────────────────
 Why step 3, why now, why this model
  • On plan: step 3 "Wire /callback" is in_progress (approved 2m ago).
  • Model: sonnet via route:auto — task_type=code, difficulty=med, $0.05 est.
  • Drift: 1 off-plan write (billing/stripe.ts) — not attributed to a step.
  • Last gate: plan_approval → approved (user, 2m ago).
 ─ esc close ────────────────────────────────────────────────────────────────

── DIFF overlay (ctrl+d) ────────────────────────────────────────────────────
 Changes this run — 4 files, +81 −12          (● on-plan  ⚠ off-plan)
 ● src/auth/callback.ts     +40 −0
 ● src/auth/config.ts       +12 −4
 ⚠ billing/stripe.ts        +14 −2   ← off-plan
   … unified diff of selected file, scrollable …
 ─ ↑↓ file · pgup/pgdn scroll · esc close ───────────────────────────────────

── APPROVE overlay (auto-raised when a plan/step needs a gate) ──────────────
 Approve plan? "Add OAuth login" — 7 steps, ~$0.40 projected
   [enter] approve   [e] edit before approving   [r] reject   [esc] later
```

### 5.3 Keymap

No keymap registry exists (inline `if (key.…)` across `useInput` hooks). Phase 4 adds a tiny
central `keymap.ts` (data table → handler) so bindings are discoverable and testable. Proposed
bindings (all shown in the strip hint row):

| Key | Action | Enforcement seam |
|---|---|---|
| `ctrl+g` | Open plan overlay | TUI only |
| `ctrl+y` / `/why` | Open why overlay | reads ledger (`agent.db`) |
| `ctrl+d` | Open diff overlay | reads `file_changes` |
| `esc` (busy) | **Steer** (open 1-line steer input) or **abort** on 2nd press | `agent.abort()` + steer queue |
| `a` (drift/gate) | Accept drift / approve gate | resolves `gates` row |
| `r` (gate) | Reject | resolves `gates` row → blocks tool |
| `enter` (approve overlay) | Approve plan | resolves `plan_approval` gate |

`esc` semantics are deliberate: first `esc` while busy opens a steer line (cheap, **non-destructive**
redirect — work-so-far is kept); a second within the existing 2.5 s window aborts (reuses
`app.tsx:935–957`). This mirrors Claude Code's soft-`Esc` / `Esc Esc` split and directly answers the
survey's #7/#8 implications; both bindings stay visible in the strip hint row so the Enter/Esc/Ctrl-C
confusion that plagues other tools (CC #16905, #36326) never arises here.

### 5.4 The three redirect levers (P2)

| Lever | UX | Enforcement | Ledger row |
|---|---|---|---|
| **Steer** | `esc` → 1-line input → queued | Guidance appended to next-turn context (projection + `transformContext`), applied at the turn boundary — never mid-tool | `user_signals(kind=steer)` |
| **Hard-interrupt** | 2nd `esc` / `ctrl+c` | `agent.abort()` (`agent.ts:184`); cooperative — some provider streams can't cancel mid-flight (`app.tsx:936–940`, the #83 nuance). Phase 4 makes the strip show `aborting…` and finalizes the run row | `user_signals(kind=abort)` |
| **Plan-approval** | Approve overlay at plan commit | `beforeToolCall` (`loop.ts:232–245`) **awaits** the user decision *before* the parallel execution plan runs (`loop.ts:222–260`), so approval naturally serializes ahead of any tool. `reject` → `errorResult` back to the model | `gates(kind=plan_approval)` |

**Steering safety:** steering is queued to the turn boundary rather than injected mid-tool, so it
can't corrupt an in-flight tool result; if the user wants *immediate* stop, that's the interrupt
lever. This mirrors Claude Code's "queue a message while it's working" behavior.

---

## 6. Painpoint → mechanism traceability

| Pain | Strip element | Overlay | Lever | Acceptance test (PTY) |
|---|---|---|---|---|
| 1 follow what it's doing | `◇ now:` live line + `step X/N` | plan | — | snapshot shows current step + action without scrolling |
| 2 wrong task / drift | `⚠ DRIFT` state | plan (⚠ off-plan) | steer | write to unclaimed file → strip flips to DRIFT within 1 turn |
| 3 tell when plan went wrong | drift + gate outcome | why | — | `/why` names the divergence from a ledger fact, not a score |
| 4 must scroll to see plan | pinned plan title + step | `ctrl+g` plan | — | plan visible in footer at all scroll offsets; overlay opens in ≤1 key |
| 5 no watchable/steerable truth | whole strip | all | steer/interrupt/approve | reject-plan gate blocks the first write; steer changes next turn |

---

## 7. Phased mini-projects (stepping stones)

UX-first ordering. Each phase is independently shippable behind `MINIMA_TUI_GROUND_TRUTH` (§8.6).
GT codenames map to the spec's ladder; the sequence is reordered so a **visible painkiller ships
first** and the ledger deepens underneath it.

> **Dependency spine:** P0 → P1 (no schema) → P2 (schema v3) → P3 (plan tools + diff) → P4 (overlay
> stack + #83) → {P5 (HUD + approval), P6 (/why v1)} → P7 (macros). Parallel-safe after P2:
> {P3, P4}. After P4: {P5, P6}. P7 needs P2 + P4.

---

### Phase 0 — Research validation + schema sign-off · ~2 d · no code

*The dedicated research phase.* Turn the survey (Appendix B) into decisions and lock the v3 shape
before any migration merges (the §13.1 blocker).

- Produce the prior-art matrix (how Claude Code / Aider / Codex CLI / Plandex / Cursor / Crush /
  opencode surface, drift-signal, and steer/interrupt/approve) and a **design-decision log** citing
  which finding drove each choice in §3/§5.
- Sign off the §4 v3 DDL shapes (`plan_steps.step_id`, `file_changes`, `gates.origin/two_sided`,
  payload JSON conventions) — append-only, so this is one-way.
- **Gate:** decision log merged; v3 DDL reviewed by a second engineer; wireframes (§5) validated
  against ≥5 comparable tools with at least one anti-pattern documented per §3 principle.

---

### Phase 1 — GT-0.5 · Visibility quick wins (no schema) · ~3 d · ships v0.7.x

Fastest path to killing pains 1 & 4 using state that already exists — **no migration**.

- **Strip v0** (`tui/GroundTruthStrip.tsx` new; mount `app.tsx:2302`; height into `footerHeight`
  `app.tsx:1992`): render `step X/N` + current step from the **existing ephemeral** `todowrite`
  state (`tools/todowrite.ts`) surfaced onto `HarnessApp`, plus the live `currentAction` line.
- **`/why` v0** (`COMMANDS` `app.tsx:154` + `handleCommand` switch, template = `/cost` case
  `app.tsx:1448–1459`): print the last routing decision (`agent.db.getRunDecisions(agent.runId)`) —
  model, task_type, cost, outcome. Read-only, no ledger yet.
- **Files:** `tui/GroundTruthStrip.tsx` (new), `tui/app.tsx` (mount + `footerHeight` +
  `chatRegionHeight`/`streamReserved` accounting), `tui/status.tsx` (no-plan hint), `tools/todowrite.ts`
  (expose state to the app).
- **Gate:** `make tui-shot` snapshot shows the strip with `step 2/5` glued above the prompt in
  fullscreen **and** inline, at 80×24 and 40×12, with no garble; `layout.ts` row math updated and
  unit-tested; strip hidden when no todos. **Telemetry:** none yet.
- **Risk:** ephemeral todo state resets across turns → strip flickers. Mitigation: this is exactly
  what P2/P3 fix by persisting; ship P1 as an explicit "preview".

---

### Phase 2 — GT-0 · Thin ledger core (schema v3 + hooks + protection) · ~1 wk · ships v0.8.x

The persistence spine the rest reads.

- **Schema v3:** append the §4 array at `db/minima_db.ts:130`; add typed writers (`minima_db.ts:230+`).
  Migration test: fresh DB → v3; a v2 DB upgrades to v3 idempotently; v1/v2 arrays byte-unchanged.
- **Ledger sink:** extend the event subscriber (`db/sink.ts:106–149`) to write `plan_steps`
  status transitions and `file_changes` inside the existing per-turn `db.transact` flush
  (`sink.ts:71–104`), reusing `markDegraded` fail-open.
- **Hook composition layer** (`agent/agent.ts:111–123`): wrap the single-slot `beforeToolCall` /
  `afterToolCall` (`agent/tools.ts:49–71`) so multiple consumers (permissions, plan-mode, GT gates,
  GT diff-capture) compose instead of overwrite. Add an optional pre-turn hook if projection needs it.
- **Projection re-injection** (`minima/runtime.ts:158–164` pattern): inject the compact plan
  projection each prompt; restore in `finally`.
- **DB self-protection:** assert no agent-facing tool can write ledger tables (test).
- **Gate:** migration + writer unit tests green; a scripted run writes `plans`/`plan_steps`/
  `file_changes` rows joinable to `routing_decisions` by `rec_id`; degraded-run test (forced write
  failure) doesn't break the turn. **Telemetry:** every step row carries `task_type` + `rec_id`.

---

### Phase 3 — GT-1 · Plan tools + protocol + diff capture · ~1 wk · ships v0.8.x

Make the plan real and attributable; strip now reads the ledger, not ephemeral state.

- **`plan` tool** (upgrade `tools/todowrite.ts` → persisted; register `tools/builtin.ts:45–56`;
  thread `db`/`runId` via factory like `taskTool` in `main.ts:438–448`): `op: propose|update|
  set_status|done`. System-prompt protocol: exactly one step `in_progress`; mark `done` only when
  verified; propose before executing multi-step work (3+). This folds in `/goals` semantics.
- **Diff capture (greenfield):** in the composed `afterToolCall` (`loop.ts:296–308`), for
  `write`/`edit`/`apply_patch`, compute the unified diff (reuse the `git diff` shell-out precedent
  `app.tsx:1214–1222`; base `runs.git_base_sha` `main.ts:543–551`) and write `file_changes`,
  attributing to the `in_progress` step — **`step_id = NULL` ⇒ drift**.
- **`/v1/plan` proposer (optional):** wire the dormant `MinimaClient.recommendWorkflow` /
  `/v1/plan` (`client.ts:142–144, 185–187`) as a *draft* proposer that lands `plans(origin=server)`
  — recommend-only, no server-side store.
- **Strip → ledger:** GT strip reads `plan_steps`; drift state driven by an off-plan `file_changes`
  row.
- **Gate:** a multi-step run persists a plan + steps + per-write diffs; editing an unclaimed file
  produces a `file_changes(step_id=NULL)` row and flips the strip to DRIFT in the next snapshot;
  `/why` v0 still works. **Telemetry:** step `actual_cost_usd` attributed from `CostRow`.

---

### Phase 4 — GT-2a · Overlay stack + keymap + hard-interrupt (#83) · ~1 wk · ships v0.8.x

The interaction backbone.

- **OverlayStack** replacing the boolean ternary (`app.tsx:577–581`, `1995`, `2190–2298`): stack
  state, top-owns-input, `Esc` pops. Migrate existing pickers onto it (no behavior change).
- **`keymap.ts`** (new): central binding table; strip hint row reads from it.
- **Hard-interrupt / #83:** first `esc` (busy) opens the steer line; 2nd within 2.5 s aborts
  (`app.tsx:935–957` → `agent.abort()`); surface `aborting…` in the strip and finalize the run row;
  document the mid-flight-stream caveat (`google.ts`) and make abort visibly cooperative rather than
  silently ignored. Write `user_signals(kind=abort)`.
- **Gate:** PTY snapshots open/stack/pop plan+why overlays; abort during a running turn shows
  `aborting…` and the run ends `aborted`; overlay rows accounted in layout (no garble). **Telemetry:**
  `user_signals` abort rows land.

---

### Phase 5 — GT-2b · Plan HUD overlay + approval flow + steer · ~1 wk · ships v0.9.x

The full watch-and-redirect surface.

- **Plan HUD** (`tui/overlays/PlanOverlay.tsx`): the §5.2 plan view over the ledger; drift row;
  per-step model/cost.
- **Plan-approval gate:** on `plan.propose` (or first write when `mode≥gate`), raise the Approve
  overlay; `beforeToolCall` **awaits** the decision before execution (`loop.ts:232–245`); `reject`
  → `errorResult`; write `gates(kind=plan_approval, outcome=…)`. In `observe` mode, auto-approve and
  log `outcome=auto` (visible, not silent).
- **Steer lever:** the `esc` steer line queues guidance into the next-turn projection; write
  `user_signals(kind=steer)`.
- **Gate:** rejecting a proposed plan blocks the first write and returns a tool error the model
  reacts to; approving proceeds; steering changes the next turn's context (asserted via a scripted
  run); enforcement mode respected. **Telemetry:** gate outcomes + steer signals per `rec_id`.

---

### Phase 6 — GT-2d · `/why` v1 (drift explanation) · ~3 d · ships v0.9.x

Turn `/why` from "last decision" into "why *this*, and is it on-plan".

- **Why overlay** (`ctrl+y`): on-plan status (which step, when approved), model rationale
  (task_type/difficulty/cost from `routing_decisions`), drift (off-plan `file_changes`), last gate
  outcome — all ledger facts, no fabricated score (principle §3.3).
- **Gate:** with an injected off-plan write, `/why` names the divergence and the owning-vs-actual
  step; snapshot asserts the four bullet lines. **Telemetry:** none new.

---

### Phase 7 — GT-6 · Steering macros + `user_signal` as routing feature · ~4 d · ships v0.9.x

- **Macros:** parameterized steer/redirect snippets (`/macro`), and capture *every* user redirect
  (`steer|abort|reject|approve|edit`) into `user_signals` joined by `rec_id` — the objective
  "human corrected the agent here" signal for Mubit routing (feeds GT-7 later).
- **Gate:** macros expand into steer input; every lever writes a `user_signal` row with `rec_id`.
  **Telemetry:** the signal table is the deliverable.

---

### Out of this slice (named dependencies, stubbed)

`$EDITOR`-edit of the plan (GT-2c), the full **gates engine** (GT-3), **policy engine** (GT-4),
**audit/summaries + Work Record export** (GT-5, folds #76), **feedback wire v2** (GT-7, needs #72),
**pinning + observed-best** (GT-8, #77 reprice hook). Each is referenced where this slice leaves a
seam (e.g. `gates.kind`/`origin`/`two_sided` are v3-ready for GT-3).

**Strong future candidates surfaced by the survey (post-slice, high value):**
- **Rewind-to-checkpoint** — snapshot plan+code at each accepted step so a wrong turn is one key,
  not an unwind. Plandex's explicit finding is "a clean slate beats corrective re-prompting"; this
  is also the top user-invented workaround (save-plan-as-checkpoint). Seam already exists: `/undo`
  (`app.tsx:1214–1222`) + `runs.git_base_sha`. Pairs with GT-5.
- **Diff-before-disk sandbox** — accumulate proposed writes for review before `apply` (Plandex's
  "dramatically safer for 20–30-file refactors"; opencode #5102 wants auditable *combined* diffs).
  Aligns with the deferred diff-approval note at `runtime.ts:12–13`; extends GT-3.
- **Confidence-gated auto-pause** — a Devin-style 🟢/🟡/🔴 that pauses below a threshold rather than
  gating every step. Unique among tools and highly rated; folds into the GT-3 gate engine.

---

## 8. Cross-cutting concerns

### 8.1 Render-invariant compliance (non-negotiable)
Any strip/overlay row **must** be added to `footerHeight` (`app.tsx:1992`) and flow through
`streamReserved` (`:2017`) and `chatRegionHeight` (`:2037`); the cardinal rule is "estimates ≥ real
rendered rows" (`layout.ts:18–21`). Under-counting garbles fullscreen (flex-end overflow) or wipes
inline scrollback (`clearTerminal`, `SCROLLBACK_SAFETY_ROWS`). Every UX phase's gate includes a
40×12 snapshot. Below 40×10 the existing resize notice stands (`app.tsx:2067`).

### 8.2 Fullscreen ↔ inline parity
Both renderers share `HarnessApp`; the strip lives in the shared fixed footer, so it renders in
both. Snapshots run under both (`MINIMA_TUI_INLINE` set/unset).

### 8.3 Testing strategy
- **PTY snapshots** (`packages/tui/scripts/pty_capture.py`, `make tui-shot SPEC=…`) per UX phase —
  timed `steps` open each overlay/strip; assert on grid *and* scrollback history.
- **Unit tests** for `layout.ts` row math and the `keymap.ts` table.
- **DB tests** for migration idempotency, writer round-trips, `rec_id` joins, degraded-run fail-open.
- **Never set `CI`** in PTY runs (flips Ink non-interactive) — per the harness's testing notes.

### 8.4 Performance
Projection ≤ ~15 lines; ledger writes batched in the per-turn `db.transact` flush; WAL +
`busy_timeout=5000` already set (`minima_db.ts:196`). Diff capture truncates large diffs (store
counts, `diff=NULL`).

### 8.5 Accessibility / robustness
No color-only signals — drift uses `⚠` + word "off-plan", not just red; strip degrades gracefully
in narrow terminals (truncate, `wrap="truncate"` like `StatusBar`); honor `NO_COLOR`.

### 8.6 Feature flag & rollout
New env `MINIMA_TUI_GROUND_TRUTH` (pattern: read in `parseArgs` `main.ts:192`, prop into
`render(HarnessApp,…)` `main.ts:522`, gate in `app.tsx`). Off → zero behavior change. Rollout:
opt-in through P1–P4, default-on at P5 once approval + abort are solid, remove flag after a version.

### 8.7 Enforcement default (recommendation — "recommend for me")
Reuse the existing `shadow|warn|enforce` vocabulary (`budgets.mode`, `minima_db.ts:109`) as
`MINIMA_GT_ENFORCE`:
- **`observe` (default):** watch + flag drift; plan-approval auto-approved but logged
  (`gates.outcome=auto`); risky ops still use the *existing* permission system. Lowest friction —
  answers pains 1–4 without gate fatigue.
- **`gate`:** require plan-approval; block off-plan writes and risky ops until approved.
- **`strict`:** per-step approval; any deviation blocks.

Rationale: CLI users abandon over-gating; the pains are *visibility*-led, so ship watchability
default-on and make blocking opt-in. All three levers exist in every mode — only the *default
friction* changes.

### 8.8 Terminal-native preservation, quiet-mode & flicker (survey-driven)
The survey's two most-punished anti-patterns are (a) breaking native copy/scroll/search and (b)
flicker/noise. Hard constraints, learned from tools that shipped the mistake:
- **Don't force alt-screen.** Keep the inline renderer (`MINIMA_TUI_INLINE`, `<Static>` scrollback)
  a first-class, *default-eligible* mode; if fullscreen is used, preserve a transcript escape hatch
  (existing PgUp/PgDn scroll + a flush) so native find/copy still reach the plan and diffs. Gemini
  reverted default alt-screen within a week ([PR #13623]); Anthropic declined it outright. This is a
  graveyard — the GT strip must work in *both* renderers (§8.2), never require alt-screen.
- **No new flicker.** The strip redraws only on state change (memoize); reuse the existing
  reserved-rows + `<Static>` discipline; never redraw the transcript just to update the strip.
- **Verbosity is a toggle, not a default** (the v2.1.20 over-collapse backlash): `MINIMA_GT_STRIP=
  full|compact|off`, honor reduced-motion and `NO_COLOR`; drift uses `⚠` + the word "off-plan",
  never color alone (§8.5).
- **No truncation cliff.** The strip shows current step + count; the plan overlay shows *all* steps
  with scroll — CC's `Ctrl+T` 5-item cap is a specifically documented pain (#54355).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Strip/overlay trips the garble invariant | Row accounting + 40×12 snapshot in every UX gate (§8.1) |
| Approval gates cause fatigue | `observe` default; approve-once-per-plan not per-step; risky-op scoping (§8.7) |
| Abort can't cancel mid-flight stream (#83) | Cooperative abort + visible `aborting…`; document caveat; 2nd `esc` escalates (§Phase 4) |
| Model lies about plan/drift | Ground truth is the ledger + `file_changes(step_id)` attribution, not model self-report (§3.2, §4) |
| Append-only migration mistakes | Never edit shipped indexes; v3 sign-off is Phase 0 gate; migration idempotency test |
| Divergence from Python `/goals` | Subsumed, not parallel (§2); Goal model is a subset of `plan_steps` |
| Projection bloats context | ≤15-line cap; restore-in-`finally`; measure token delta |

---

## 10. Open questions / decisions log

- **Drift definition v1:** off-plan = a `write/edit/apply_patch` to a path no `in_progress` step
  claims. Do we also flag "no step `in_progress` during a write"? (Proposed: yes, as a softer
  `⚠ unplanned` variant.) — *decide in Phase 0.*
- **Step↔file attribution:** v1 attributes writes to the single `in_progress` step. Multi-step
  interleaving deferred to GT-5. — *accepted.*
- **`/v1/plan` proposer:** ship in P3 as optional draft or defer to a later phase? — *lean defer;
  local plan tool first.*
- **Strip height:** 2 rows default, 3 when a gate is pending? Confirm against 40×12 budget. — *Phase 1.*
- **Where projection injects:** `promptRouted` recall pattern (per-prompt) vs `transformContext`
  (per-turn). — *Phase 2 spike.*
- **Fullscreen default?** Given the alt-screen graveyard (§8.8), keep the scrollback-native inline
  renderer as the GT default and make fullscreen opt-in? — *Phase 1 decision.*
- **Confidence gate?** Add a Devin-style confidence signal that auto-pauses low-confidence steps?
  Strong survey support; likely a GT-3 gate — *note now, defer.*
- **Rewind vs re-prompt** as the drift-recovery primitive (Plandex model, plan+code checkpoints)?
  — *post-slice; design seam via `/undo` + `git_base_sha`.*
- **Steer injection point:** next-turn boundary (safe, our default) vs Codex-style "inject into
  current turn" (Enter) — is mid-turn injection ever worth the in-flight-tool risk? — *revisit after
  P5 usage.*

---

## Appendix A — Verified architecture seams (file:line)

| Concern | Location | Note |
|---|---|---|
| Dispatch / turn loop | `agent/loop.ts:51–160` | `agentLoop()` async generator |
| **P2 pre-tool gate** | `agent/loop.ts:232–245` | `beforeToolCall` can `block`; awaited before parallel exec (`:222–260`) |
| Post-tool (diff capture) | `agent/loop.ts:296–308` | `afterToolCall` can rewrite result / `terminate` |
| Hooks (single-slot) | `agent/agent.ts:111–123`, `agent/tools.ts:49–71` | need composition layer (P2 phase) |
| Event subscriber / sink | `agent/agent.ts:126–141`, `db/sink.ts:71–149` | fail-open `markDegraded` |
| DB + migrations | `db/minima_db.ts:29–130` (arrays), `:200–216` (`migrate`) | **v2 today**; v3 appends at `:130` |
| Routing telemetry | `minima/runtime.ts:326–402` (`persistDecision`), `routing_decisions` `minima_db.ts:61–85` | `rec_id` join key |
| Per-turn re-injection | `minima/runtime.ts:158–164` + restore `:312–316`; `state.ts:66–71` (`transformContext`) | projection hook |
| Ephemeral plan primitive | `tools/todowrite.ts:28–65`, wired `tools/builtin.ts:45–56` | upgrade → persisted (P3) |
| Diff / git precedent | `app.tsx:1214–1222` (`/undo`), `main.ts:543–551` (`git_base_sha`) | reuse for `file_changes` |
| Abort (#83) | `agent/agent.ts:164–186`, TUI `app.tsx:923–976` | cooperative; mid-flight caveat `:936–940` |
| Footer / strip mount | `app.tsx:2302–2345`; plan-banner precedent `:2244–2250` | height → `footerHeight:1992` |
| Layout invariant | `layout.ts:18–21`, `app.tsx:2017–2045`, `2067` (resize bail) | estimates ≥ rendered rows |
| Slash commands | `COMMANDS app.tsx:128–154`, `handleCommand:1145`, `/cost:1448–1459` | template for `/why` |
| Config/env flag | `main.ts:192`, `config_store.ts:288–296`, prop `main.ts:522` | `MINIMA_TUI_GROUND_TRUTH` |
| PTY snapshot tests | `packages/tui/scripts/pty_capture.py`, `Makefile:65` | grid + scrollback |

## Appendix B — Prior-art & benchmarking survey

A 5-agent, cross-verified web study. Confidence flags: **[primary]** official docs/merged PR ·
**[issue]** real GitHub issue · **[anecdote]** HN/Reddit/blog. Strongest evidence = primary +
merged PRs + reproducible issues; single-author feature requests are flagged, but their *themes
recur across independent tools*. One unverifiable rumor (a "Gemini CLI shutdown") was excluded.

### B.1 How comparable tools surface / detect-drift / steer

| Tool | See the plan | Drift control | Steer / interrupt / approve |
|---|---|---|---|
| **Claude Code** | plan mode (read-only) via `Shift+Tab` / `/plan`; live TodoWrite checklist, `Ctrl+T` (**caps at 5 tasks, no scroll**); todos persist across compaction | permission mode *is* the guardrail (plan mode can't write) | single `Esc` = soft interrupt/steer (keeps work); `Esc Esc` = rewind menu; `Ctrl+C` hard stop; approve → auto / accept-edits / manual / keep-planning; `Ctrl+G` edits plan in `$EDITOR` |
| **Codex CLI** | `update_plan` always-on (PR #5384); "approve/reject steps inline"; NDJSON via `exec --json` | prompting contract: "never end with only a plan" | **Enter = inject into current turn; Tab = queue next turn**; `Esc` interrupt; 3 approval presets × 3 sandbox levels |
| **Aider** | `code` / `ask` / `architect` / `help` modes; `/ask` → "go ahead" → `/code` | repo map (tree-sitter, token-budgeted); every edit = git commit | `/diff`, `/undo`, `/add` / `/drop` / `/reset` |
| **Plandex** | plan = persistent, version-controlled object w/ branches; streaming "plan TUI" (`s` stop, `b` background) | **rewind-to-clean-slate preferred over re-prompting** | **cumulative diff sandbox** — nothing written until `plandex apply`; `diff --ui` browser review; autonomy ladder `--none..--full` |
| **Cursor CLI** | Plan Mode (Jan 2026): editable/reviewable to-do list; `/ask` read-only | catch wrong approach before multi-file unwind | ACP `cursor/create_plan` **blocks** until accept/reject |
| **Cline / Roo / opencode / Gemini / Copilot / Devin / Warp** | explicit Plan→Act gate (Cline); plan-as-Markdown + external editor (Gemini `Ctrl+X`); Devin **confidence 🟢🟡🔴 auto-pause**; Warp plan saved / versioned / attached-to-PR | approval-gated subtasks (Roo Orchestrator); Devin pauses below-green | per-edit approve/reject diffs; "Deny + tell it what to do differently" (Copilot) |

**Two families:** (1) an editable read-only **plan you approve before execution** (most tools); (2)
Plandex's **persistent plan + diff sandbox** controlled at apply/rewind. Drift control splits three
ways: per-step approval (most), **confidence-gated auto-pause** (Devin, unique), **rewind-to-clean-
slate** (Plandex, explicitly preferred). Sources: [CC permission-modes](https://code.claude.com/docs/en/permission-modes),
[CC interactive-mode](https://code.claude.com/docs/en/interactive-mode), [CC fullscreen](https://code.claude.com/docs/en/fullscreen),
[Codex features](https://developers.openai.com/codex/cli/features) + [PR #5384](https://github.com/openai/codex/pull/5384),
[Aider modes](https://aider.chat/docs/usage/modes.html), [Plandex](https://github.com/plandex-ai/plandex) +
[version-control](https://docs.plandex.ai/core-concepts/version-control/), [Cursor plan-mode](https://cursor.com/blog/plan-mode),
[Cline Plan/Act](https://docs.cline.bot/core-workflows/plan-and-act), [Devin 2](https://cognition.com/blog/devin-2).

### B.2 Painpoints (mapped to our five)
- **P1 follow:** "you lose all visibility… can't tell if it finished, errored, or is waiting"
  ([blog](https://www.makeuseof.com/found-free-tool-that-fixes-claude-codes-biggest-limitation/));
  "not clear if it's stuck" ([Gemini #2456](https://github.com/google-gemini/gemini-cli/issues/2456));
  users "walk around with laptop open to catch it heading the wrong way"
  ([XDA](https://www.xda-developers.com/stopped-babysitting-claude-code-with-goal-command/)).
- **P2 drift:** "Claude abandons our plan… 'sorry I drifted away'", reproducible every time
  ([CC #32253](https://github.com/anthropics/claude-code/issues/32253)); "completely ignoring plan
  mode… blows past it" ([CC #41062](https://github.com/anthropics/claude-code/issues/41062)); "I
  chose fast instead of correct" ([CC #24129](https://github.com/anthropics/claude-code/issues/24129));
  Codex repeatedly ignores AGENTS.md ([#6502](https://github.com/openai/codex/issues/6502)).
- **P3 late discovery:** "mistakes compound… baked into the code by the end"
  ([SO blog](https://stackoverflow.blog/2026/01/28/are-bugs-and-incidents-inevitable-with-ai-coding-agents/));
  Codex silently truncates AGENTS.md at 32 KB "with no warning in the TUI"
  ([#13386](https://github.com/openai/codex/issues/13386)); "wrong-direction *plan* costs 100 tokens;
  wrong-direction *code* costs 1000+".
- **P4 scroll (definitive):** "the original plan **scrolls up and out of view**… I constantly stop
  and scroll up… breaks my focus" — asks for a sticky panel, tagged "Critical"
  ([CC #8723](https://github.com/anthropics/claude-code/issues/8723)); alt-screen "cannot scroll
  back… loses architectural decisions and reasoning" ([CC #28077](https://github.com/anthropics/claude-code/issues/28077));
  `Ctrl+T` shows only top 5 ([CC #54355](https://github.com/anthropics/claude-code/issues/54355)).
- **P5 no steer (definitive):** "no way to **steer** mid-execution… messages queue to the next turn
  boundary, by which point Claude may have done significant work in the wrong direction… Escape is
  destructive: it discards in-progress work" ([CC #30492](https://github.com/anthropics/claude-code/issues/30492));
  "Enter only queues; to interrupt, Ctrl+C first" ([#36326](https://github.com/anthropics/claude-code/issues/36326));
  "Esc does nothing with queued messages… 30+ min with no way to stop" ([#16905](https://github.com/anthropics/claude-code/issues/16905)).
- **Workarounds users built:** persistent PLAN.md/todo.md checked off across sessions; CLAUDE.md
  rules ("don't refactor unrelated code", "95% confidence before changes", keep it <80 lines); save
  plan as a checkpoint; external status bars (`claude-status-bar`, statusline); a PreToolUse hook +
  external-terminal `steer` alias.

### B.3 TUI patterns + the alt-screen fork
- **Fixed HUD:** DECSTBM scroll-margins (must reset on exit); alt-screen `?1049h`; tmux multi-line
  status; Lip Gloss `Place`/z-layers; **Claude Code fullscreen = alt-screen + bottom-pinned input +
  only-visible-rows in the render tree** (our exact target — and what `HarnessApp` already does).
- **Flicker-free:** synchronized output **DEC 2026** (`?2026h/l`) for atomic frames; per-cell diff
  renderers (Ratatui / notcurses / opencode's opentui); **Ink's full-tree re-render is the known
  culprit** — the reason Claude Code and opencode left Ink.
- **Overlays:** tmux `display-popup`, Textual `ModalScreen` (`push_screen`/`dismiss`), fzf
  toggle-preview, lazygit focus-capturing popups + "disabled reason" toasts (clean HITL affordance).
- **Diff:** delta side-by-side + word-level + `--navigate`; lazygit diff panel.
- **The recurring fork:** alt-screen (no flicker, **breaks copy/scroll/search**) vs scrollback
  (native muscle memory, must fully redraw → flicker). **Gemini enabled default alt-screen and
  reverted within a week** ([PR #13623](https://github.com/google-gemini/gemini-cli/pull/13623));
  **Anthropic explicitly declined alt-screen** and built a differential scrollback renderer instead
  ([steipete](https://steipete.me/posts/2025/signature-flicker)).

### B.4 Anti-patterns (what triggered revolts)
- **Over-collapse backfired symmetrically:** v2.1.20 reduced reads to "Read 3 files." →
  "overwhelmingly negative", users pinned back to v2.1.19. The fix in *both* directions was **a
  toggle, not a fixed default** ([symmetrybreak](https://symmetrybreak.ing/blog/claude-code-is-being-dumbed-down/)).
- TodoWrite overwrites the whole list (todo loss, [#2250](https://github.com/anthropics/claude-code/issues/2250));
  proactive checklists felt like noise ([#6968](https://github.com/anthropics/claude-code/issues/6968)).
- **Flicker plague:** full-redraw per chunk ([#37283](https://github.com/anthropics/claude-code/issues/37283)),
  6,700 scroll-events/sec in tmux ([#9935](https://github.com/anthropics/claude-code/issues/9935)),
  photosensitivity hazard ([#769](https://github.com/anthropics/claude-code/issues/769)); then the
  flicker-fix destroyed scrollback ([#41965](https://github.com/anthropics/claude-code/issues/41965)).
- **Escape hatches teams shipped:** CC `Ctrl+o` transcript, Codex `/raw` + `--no-alt-screen`, quiet
  / reduced-motion toggles (`CLAUDE_CODE_NO_FLICKER`, `spinnerTipsEnabled:false`).

### B.5 Top design implications → our phases
1. **Pin the plan HUD above the prompt, never let it scroll** → P1/P4/P5 (CC #8723).
2. **No hidden truncation cliff** — HUD shows step+next+count, overlay shows all + scroll → P1/P5 (CC #54355, Codex #18658).
3. **Plan = editable, approve-before-execute artifact = the ground truth** → P3/P5.
4. **Live per-step status, one `in_progress`, quiet** → P1/P3 (Codex `update_plan`).
5. **Detect + flag drift explicitly, with a "why"** (lazygit disabled-reason) → P3/P5/P6 (CC #32253/#41062).
6. **Confidence/verification gate that pauses on shaky steps** (Devin 🟢🟡🔴) → GT-3 / open Q.
7. **Non-destructive mid-run steering — the biggest unmet need** → P5/P4 (CC #30492).
8. **Separate interrupt from steer, label both in the status line** → P4/P5 (Codex Enter/Tab, CC #16905).
9. **Plan version-control + rewind-to-checkpoint, not re-prompt** → future (Plandex).
10. **Reviewable diff before disk / trivially reversible writes** → P4 + future sandbox (Plandex, opencode #5102).
11. **Don't break terminal-native copy/scroll/search — toggle + escape hatch, don't force alt-screen** → §8.8 (Gemini PR #13623, CC #28077).
12. **Engineer against flicker + make verbosity a toggle from day one** → §8.8 (CC #37283, symmetrybreak).

**Method:** 5 parallel search+fetch agents (Claude Code/Aider/Codex · Plandex+long-tail ·
painpoints · TUI patterns · anti-patterns), cross-verified; the load-bearing findings
(Enter-queues/Esc-destructive, `Ctrl+T` 5-todo cap, plan-scrolls-out-of-view, Plandex
sandbox/rewind, alt-screen-vs-scrollback, per-cell diff rendering) are each corroborated by ≥2
independent agents or primary docs.
