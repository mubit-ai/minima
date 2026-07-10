# Ground-Truth — Builder's Guide

**A hands-on, build-it-yourself ladder.** This is the _companion_ to `ground-truth-tui-plan.md`. That doc explains the architecture and the "why". This doc is the "how": ~25 tiny mini-projects, in order, each one small enough to finish in one sitting, each ending with **something you can run and see**. You learn the system by building it, one observable slice at a time.

> **Golden rule of this guide:** every mini-project (MP) leaves the app fully working. Everything new lives behind the `MINIMA_TUI_GROUND_TRUTH` flag (off by default), so `main` stays shippable. If you stop after any MP, you still have a real, working feature. Each MP is one PR that keeps `bun test` green.

---

## 1. How to use this guide

- Do the MPs **in order** — each builds on the last.
- Each MP has the same shape:
  - **Goal (plain):** one sentence, no jargon.
  - **Why:** what capability/understanding it unlocks.
  - **Build:** the concrete files/functions to touch (real seams in this repo).
  - **See it work:** the exact command / query / snapshot and _what you'll observe_.
  - **Done when:** the crisp finish line.
  - **Size / needs:** rough effort + which MP it depends on.
- When an MP says "see it work", actually run it. That's where the understanding lands.
- Terms you don't recognize are in the Glossary (§3).

---

## 2. The one-paragraph mental model

You are building a system where **the agent writes a plan, does the work, and the harness _checks_ each step actually happened before letting the agent move on** — and every check result is written to one small database (the "ledger") that two readers consume: the **screen** (so you can watch) and **Minima** (so it learns which model actually succeeded). "Checking" means: run the step's test, and only believe it if the test went from **failing → passing** (red→green) _because of this step's code_ (not because the agent quietly wrote a fake test). The confidence of each check (🟢/🟡/🔴) decides whether the agent glides on silently, glides on with a flag, or stops and asks you.

```
        ┌──────────────────────────────────────────────┐
        │                 THE LEDGER (one small DB)      │
        │   plans · plan_steps · file_changes · gates    │
        └───────────────┬───────────────────┬───────────┘
      writes │ reads                 reads │
              ▼                             ▼
   agent does work            ┌──────────────────┐   ┌──────────────────┐
   harness verifies  ───────► │  SCREEN (you watch) │  │ MINIMA (it learns) │
                              └──────────────────┘   └──────────────────┘
```

You build this bottom-up: first the DB, then the plan capture, then "what changed", then the check, then trust in the check, then confidence, then the learning loop, then the UI to watch it all.

---

## 3. Glossary (read once, refer back)

| Term                             | Plain meaning                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Ledger**                       | The small SQLite DB that records plans, steps, file changes, and check results. One source of truth.                            |
| **Projection**                   | Re-showing the current plan to the agent every turn (so it can't "forget" the plan).                                            |
| **Step check / verify spec**     | The command that proves a step is done (usually the project's own test, e.g. `pytest tests/auth/test_login.py::test_redirect`). |
| **Baseline / red**               | Running the step's check _before_ the work and confirming it fails.                                                             |
| **red→green**                    | The check failed before the step and passes after — that's real evidence the step did something.                                |
| **Provenance**                   | Where the check came from: a pre-existing test (trustworthy) vs a test the agent wrote this run (needs scrutiny).               |
| **Tamper**                       | The agent weakened the check (skipped/deleted tests) to make it pass.                                                           |
| **Drift**                        | The agent edited files that no step claimed — off-plan work.                                                                    |
| **Confidence tier**              | 🟢 (proceed silently) / 🟡 (proceed but flag) / 🔴 (stop and ask).                                                              |
| **Escalation / recovery ladder** | Existing logic that swaps to a stronger model and retries when something fails.                                                 |
| **Grounded outcome**             | A step result backed by a real check (not a guess), fed to Minima as the learning signal.                                       |

---

## 4. The dependency ladder (the whole map on one screen)

```
Stage 0  DB + flag           ─┐
Stage 1  persist the plan    ─┼──►  you can SEE the plan on screen (footer strip)
Stage 2  record file changes ─┘     ...and see DRIFT when work goes off-plan

Stage 3  the verify spec     ─┐
Stage 4  red→green gate       ─┼──►  a step can't be "done" unless a real check passes
Stage 5  provenance + tamper ─┘

Stage 6  confidence 🟢🟡🔴    ─────►  near-zero interruptions (only stops when it must)
Stage 7  feedback loop        ─────►  Minima learns from grounded outcomes
Stage 8  /why + demo          ─────►  you can watch and replay the whole thing
```

Stages 0–2 give you a **watchable** system. Stages 3–5 give you a **verifiable** one. Stage 6 makes it **quiet**. Stage 7 makes it **learn**. Stage 8 makes it **inspectable**.

---

## 4b. Build status & next steps (as of the SQLite-ledger branch)

**Legend:** ✅ done (behavior wired + tests green) · 🟨 scaffolded (table/column/writer exists, logic not yet wired) · ⬜ not started.

| Stage | MP                              | State | Note                                                                         |
| ----- | ------------------------------- | ----- | ---------------------------------------------------------------------------- |
| 0     | M0.1 flag + `/gt`               | ✅    | `MINIMA_TUI_GROUND_TRUTH` + command                                          |
| 0     | M0.2 `plans`                    | ✅    | table + `insertPlan`                                                         |
| 0     | M0.3 `plan_steps` + `/gt-seed`  | ✅    | table + `insertStep` + seed command                                          |
| 1     | M1.1 persist `todowrite`        | ✅    | `upsertPlanFromTodos` + afterToolCall sink                                   |
| 1     | M1.2 project plan each turn     | ✅    | `formatPlanProjection` / `planProjectionFor`                                 |
| 1     | M1.3 `step X/N` footer          | ✅    | `planStripInfo` / `planStripLabel`                                           |
| 2     | M2.1 `file_changes`             | ✅    | table + `insertFileChange`                                                   |
| 2     | M2.2 record every write         | ✅    | sink attributes each path to the in-progress step                            |
| 2     | M2.3 DRIFT footer               | ✅    | `isPathClaimed` + `countOffPlanChanges` + `planStripDrift`                   |
| 3     | M3.1 step carries `verify`      | 🟨    | `verify` column + COALESCE-preserve exist; **tool schema to attach it ⬜**   |
| 3     | M3.2 `runCheck(cmd)`            | ⬜    | the shell-out primitive — not started                                        |
| 3     | M3.3 capture baseline           | 🟨    | `baseline` column + `setStepBaseline` writer exist; **capture-on-start ⬜**  |
| 4     | M4.1 block `done` on fail       | ⬜    | needs `beforeToolCall` interception                                          |
| 4     | M4.2 require red→green          | ⬜    |                                                                              |
| 4     | M4.3 `gates` row                | 🟨    | `gates` table + `insertGate`/`getGates` exist; **write-on-verified-done ⬜** |
| 5     | M5.1 provenance                 | ⬜    |                                                                              |
| 5     | M5.2 coverage touch             | ⬜    |                                                                              |
| 5     | M5.3 tamper                     | ⬜    |                                                                              |
| 6     | M6.1 confidence fn              | ✅    | pure `confidence(Factors)` rule ladder + exhaustive tests                    |
| 6     | M6.2 tier → behavior            | ✅    | `behavior.ts` (tier→UI) + `ledgerBehavior` footer note/block + PTY proof     |
| 6     | M6.3 log overrides              | 🟨    | `user_signals` table + `recordUserSignal` exist; **capture ⬜**              |
| 7     | M7.1 grounded outcome → routing | 🟨    | `gt_*` columns + `attachGroundedOutcome` exist; **stamping ⬜**              |
| 7     | M7.2 feedback path              | ⬜    |                                                                              |
| 7     | M7.3 recovery ladder            | ⬜    |                                                                              |
| 8     | M8.1 `/why`                     | ✅    | ledger-backed command + seeded PTY proof; ready for live gate rows           |
| 8     | M8.2 E2E demo                   | ⬜    |                                                                              |

> **The whole DB layer is already built (schema v5).** All five ground-truth tables and the `routing_decisions.gt_*` columns are migrated, and every writer/reader the rest of the build needs already lives in `src/db/minima_db.ts` (`insertGate`, `getGates`, `recordUserSignal`, `attachGroundedOutcome`, `setStepBaseline`, …). **No further migrations are required.** The MPs the guide describes as "add table X" (M4.3, M6.3) collapse to "wire the logic that fills the table that's already there." Do **not** edit migrations v1–v5; if a genuinely new column is ever needed, append a **v6**.

**Next steps — the critical path ("make it verifiable").** Stages 0–2 gave a _watchable_ system; the payoff now is making it _verifiable_. Do these in order:

1. **M3.2 `runCheck(cmd)`** — zero-dependency primitive; start immediately (new `src/minima/check.ts`, mirror the `/undo` git shell-out: spawn, capture exit + stdout/stderr, `MINIMA_TIMEOUT`).
2. **M3.1** — extend the `todowrite`/plan tool schema so a step can carry `verify: "<cmd>"` (persistence already handled by the column + `COALESCE` in `upsertPlanFromTodos`; `parseTodos` just needs to stop dropping `verify`).
3. **M3.3** — when a step flips to `in_progress`, `runCheck(verify)` and `setStepBaseline(red|green|unrunnable)`.
4. **M4.1 → M4.2 → M4.3** — refuse `set_status(done)` until the check goes red→green, then `insertGate(...)`.

That chain is the first shippable slice of the _verifiable_ core; everything in Stages 5–8 reads from those gate rows.

---

## Stage 0 — Groundwork: a flag, a command, a table

_By the end of this stage you can turn the feature on and see an empty ledger exist._

### M0.1 — Add the on/off flag and a `/gt` status command · ~2h · needs: nothing

- **Goal (plain):** a switch to turn the whole feature on, and a command that proves it's on.
- **Why:** everything else hides behind this flag; you need the plumbing first.
- **Build:**
  - Read `MINIMA_TUI_GROUND_TRUTH` from env into your config object (near the other `MINIMA_*` flags).
  - Add a `/gt` entry to the `COMMANDS` list and a branch in `handleCommand` (`packages/tui/.../app.tsx`) that prints `Ground-Truth: ON (flag set)` or `OFF`.
- **See it work:** `MINIMA_TUI_GROUND_TRUTH=1` run the TUI, type `/gt` → you see `ON`. Run without the flag → `OFF`.
- **Done when:** the command reports the flag state correctly both ways.

### M0.2 — Add the `plans` table (schema v3, just one table) · ~3h · needs: M0.1

- **Goal (plain):** create the first ledger table and nothing else.
- **Why:** teaches you the append-only migration pattern you'll reuse for every table.
- **Build:**
  - In `minima_db.ts`, add a migration bumping `schema_version` to 3 that runs `CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, session_id TEXT, title TEXT, status TEXT, created_at TEXT)`.
  - Add a tiny writer `insertPlan(...)`.
- **See it work:** launch once (migration runs), then `sqlite3 <db> ".schema plans"` and `PRAGMA user_version;` → you see the table and version `3`.
- **Done when:** a fresh DB migrates to v3 and an old DB upgrades without data loss.

### M0.3 — Add the `plan_steps` table + a debug insert · ~3h · needs: M0.2

- **Goal (plain):** the table that holds the individual steps, plus a way to poke a row in by hand.
- **Why:** you'll want to insert fake data to test readers before the real writers exist.
- **Build:**
  - Migration: `plan_steps (id, plan_id, idx, content, status, verify TEXT NULL, created_at)`.
  - Writer `insertStep(...)`; add a hidden `/gt-seed` command that inserts one plan + two fake steps.
- **See it work:** run `/gt-seed`, then `sqlite3 <db> "SELECT idx,content,status FROM plan_steps"` → two rows.
- **Done when:** `/gt-seed` reliably produces one plan and its steps in the DB.

---

## Stage 1 — Capture and show the plan

_By the end of this stage the agent's real plan is saved and visible in the footer._

### M1.1 — Persist `todowrite` into the ledger (write only) · ~4h · needs: M0.3

- **Goal (plain):** when the agent writes its todo list, save it as a plan + steps.
- **Why:** this is the moment a plan becomes real/durable instead of living only in chat.
- **Build:**
  - In the `todowrite` tool handler, when the flag is on, upsert a `plans` row (once per task) and one `plan_steps` row per todo (`content`, `status`, `idx`).
  - Don't read it back yet — just write.
- **See it work:** run any task that produces todos, then query `plan_steps` → the agent's real steps are there with statuses.
- **Done when:** todos and their status changes appear as rows.

### M1.2 — Project the plan back to the agent each turn · ~3h · needs: M1.1

- **Goal (plain):** every turn, remind the agent of its own plan and which step is active.
- **Why:** stops the agent "losing the plot" on long tasks — the core of ground-_truth_.
- **Build:**
  - Before building the turn's system prompt, read the current plan from the ledger and inject a compact block: `Current plan (step 2/5): …`.
- **See it work:** temporarily log the assembled prompt; run a multi-turn task → the plan block is present and the active step advances.
- **Done when:** the injected block always matches the ledger.

### M1.3 — Show `step X/N` in the footer strip · ~4h · needs: M1.1

- **Goal (plain):** put the current step count on screen.
- **Why:** first time you can _watch_ the plan progress — the payoff of Stage 1.
- **Build:**
  - Add a one-line footer component (only when flag on) that reads the active plan and renders `▸ step 2/5 — <step title>`.
- **See it work:** `make tui-shot` (PTY snapshot) during a task → the strip shows the live step.
- **Done when:** the strip updates as steps change and never crashes when there's no plan.

---

## Stage 2 — Record what actually changed

_By the end of this stage every file edit is attributed to a step, and off-plan edits show as DRIFT._

### M2.1 — Add the `file_changes` table · ~2h · needs: M0.3

- **Goal (plain):** a table to log which files got written and by which step.
- **Build:** migration `file_changes (id, plan_id, step_id NULL, path, kind, origin TEXT NULL, created_at)`; writer `insertFileChange(...)`.
- **See it work:** `.schema file_changes` shows the table.
- **Done when:** migration is clean and idempotent.

### M2.2 — Record every write/edit as a file_change · ~3h · needs: M2.1, M1.1

- **Goal (plain):** whenever a write/edit tool runs, log the path against the in-progress step.
- **Why:** this is the raw material for drift, provenance, and coverage later.
- **Build:**
  - In `afterToolCall` (`loop.ts`), for write/edit/multiedit tools, read the current in-progress step id and insert a `file_changes` row (`kind = created|modified`).
- **See it work:** have the agent edit a file, then `SELECT path, step_id, kind FROM file_changes` → the row points at the right step.
- **Done when:** every agent file write produces exactly one attributed row.

### M2.3 — Detect and show DRIFT · ~4h · needs: M2.2, M1.3

- **Goal (plain):** flag edits to files that no step claimed.
- **Why:** your at-a-glance "is the agent going rogue?" signal.
- **Build:**
  - Define "claimed paths" for the in-progress step (start simple: paths the step's text mentions, or any path once you add per-step file hints). If a write isn't claimed → mark the row off-plan.
  - Footer: if any off-plan change exists, append `⚠ DRIFT (1)`.
- **See it work:** force an off-plan edit (e.g. tell the agent to touch an unrelated file); snapshot shows `⚠ DRIFT`.
- **Done when:** on-plan edits stay quiet; off-plan edits raise the flag.

---

## Stage 3 — The acceptance check (the "verify spec")

_By the end of this stage each step carries a check command, and you can run it and capture a baseline._

### M3.1 — Let a step carry a check command · ~3h · needs: M1.1

- **Goal (plain):** store the command that proves a step is done.
- **Why:** this is decision #1 — the agent _proposes_ the check.
- **Build:**
  - The `verify` column already exists (M0.3). Extend the plan/todo tool schema so the agent can attach `verify: "<test command>"` per step; persist it.
- **See it work:** run a task; `SELECT idx, verify FROM plan_steps` → each step has a proposed check command.
- **Done when:** proposed checks round-trip into the DB.

### M3.2 — Build `runCheck(cmd)` (shell out, capture result) · ~4h · needs: nothing (parallel-safe)

- **Goal (plain):** a helper that runs a command and tells you pass/fail + output.
- **Why:** the single primitive everything in Stages 4–6 leans on.
- **Build:**
  - Mirror the `/undo` git shell-out pattern: spawn the command, capture exit code + stdout/stderr, enforce a timeout (`MINIMA_TIMEOUT`), return `{ pass: boolean, output: string, durationMs }`.
- **See it work:** unit test: `runCheck("true")` → pass; `runCheck("false")` → fail; a sleeping command → times out cleanly.
- **Done when:** `bun test` covers pass, fail, and timeout.

### M3.3 — Capture the baseline (expect red) when a step starts · ~3h · needs: M3.1, M3.2

- **Goal (plain):** when a step becomes in-progress, run its check first and record that it fails.
- **Why:** the "red" half of red→green — without it you can't prove the step caused anything.
- **Build:**
  - When a step flips to `in_progress`, call `runCheck(verify)`; store `baseline = red|green|unrunnable` on the step (add a column).
- **See it work:** start a step whose check currently fails → `SELECT baseline FROM plan_steps` shows `red`. A check that already passes → `green` (you'll penalize this later).
- **Done when:** every started step with a check has a recorded baseline.

---

## Stage 4 — Gate "done" on a real red→green

_By the end of this stage the agent literally cannot mark a step done unless its check goes red→green._

### M4.1 — Block `set_status(done)` when the check fails · ~4h · needs: M3.3

- **Goal (plain):** intercept the "mark done" call; if the check fails, refuse.
- **Why:** this is the enforcement muscle — decision #1's "harness validates".
- **Build:**
  - In `beforeToolCall` (`loop.ts`), when the tool is the plan status-setter moving a step to `done`, run `runCheck(verify)`. If it fails, return an error result to the model (`Step not verified: <output tail>`), leaving status unchanged.
- **See it work:** make the agent try to finish a step while its test still fails → the tool is rejected and the model sees why.
- **Done when:** a red step can never reach `done`.

### M4.2 — Require red→green, not just green · ~3h · needs: M4.1

- **Goal (plain):** only accept if the baseline was red _and_ it's now green.
- **Why:** a check that was already green proves nothing about this step.
- **Build:**
  - Compare stored `baseline` with the fresh result. Compute `red_to_green = baseline==red && now==green`. Accept done when green; but record whether it was a true red→green or a "was-already-green" pass.
- **See it work:** a step whose check was already green → it still finishes, but the recorded flag shows `red_to_green = false`.
- **Done when:** the flag is correctly set for both cases.

### M4.3 — Add the `gates` table and record the verdict · ~3h · needs: M4.2, M2.1

- **Goal (plain):** write a durable record of each verification.
- **Why:** the screen and Minima both read from here.
- **Build:**
  - Migration `gates (id, plan_id, step_id, kind, outcome, confidence NULL, verified_by, factors_json, created_at)`.
  - On a verified done: insert `kind='step_check', outcome='verified', verified_by='deterministic'` and set `plan_steps.status='done'`.
- **See it work:** finish a step, then `SELECT kind, outcome, verified_by FROM gates` → one verified row per step.
- **Done when:** every done step has exactly one gate row.

---

## Stage 5 — Trust the check (provenance, tamper)

_By the end of this stage you know whether a passing check is trustworthy._

### M5.1 — Provenance: was the test written this run? · ~4h · needs: M4.3, M2.2

- **Goal (plain):** decide if the check is a pre-existing test or one the agent just wrote.
- **Why:** an agent that writes its own passing test is grading its own homework.
- **Build:**
  - Parse the test file path out of `verify`; look it up in `file_changes` for this run. If created/modified this run → `check_origin='agent_new'`, else `'pre_existing'` (or `'user'` if you added it at approval).
  - Store `check_origin` in the gate's `factors_json`.
- **See it work:** a step using an old test → `pre_existing`; a step whose test the agent created → `agent_new`.
- **Done when:** origin is recorded correctly for both.

### M5.2 — Coverage touch (simple heuristic) · ~4h · needs: M5.1

- **Goal (plain):** a cheap check that the test actually exercises the changed file.
- **Why:** stops "green" tests that don't touch the new code.
- **Build:**
  - Start simple: `coverage_hit = true` if the changed source file is imported/referenced by the test file (static grep) — upgrade to real coverage later. If you can't tell → `unknown`.
  - Store in `factors_json`.
- **See it work:** a test that imports the changed module → `coverage_hit=true`; an unrelated test → `false`.
- **Done when:** the factor is recorded (perfection not required — it's a signal, not a gate).

### M5.3 — Tamper detection · ~3h · needs: M5.1

- **Goal (plain):** flag when tests were skipped, deleted, or weakened this step.
- **Why:** the one factor that should _always_ stop the line.
- **Build:**
  - Scan `file_changes` for deleted test files or edits that add skip/xfail markers to tests. Set `tamper=true`.
- **See it work:** delete or `skip` a test → `tamper=true` in `factors_json`.
- **Done when:** tamper is detected for delete and skip cases.

---

## Stage 6 — Confidence: 🟢 / 🟡 / 🔴

_By the end of this stage the system decides on its own when to glide, flag, or stop._

### M6.1 — The confidence rule ladder (pure function) · ~4h · needs: M5.3

- **Goal (plain):** turn the factors into one tier, with a clear reason string.
- **Why:** this is decision #4 (Option A) and #3's tiers — kept explainable.
- **Build:** a pure function `confidence(factors) → { tier, reason }`:
  ```
  tamper                                            → 🔴  "tests weakened"
  check failed / unrunnable                         → 🔴  "check did not pass"
  no check on a writing step                        → 🟡  "no acceptance check"
  pass + red→green + coverage + origin∈{pre,user}   → 🟢
  pass + red→green + coverage + origin=agent_new    → 🟡  "self-written test"
  pass + NOT red→green (was already green)          → 🟡  "no red→green evidence"
  pass + no coverage                                → 🟡  "check may not touch changes"
  ```
- **See it work:** `bun test` with one case per row asserting tier + reason.
- **Done when:** all rows are covered by unit tests.

### M6.2 — Wire tier → behavior · ~4h · needs: M6.1, M4.3, M1.3

- **Goal (plain):** make each tier actually do something.
- **Why:** this is where "near-zero interruptions" becomes real.
- **Build:**
  - 🟢 → accept silently, proceed.
  - 🟡 → accept, proceed, add a footer note `🟡 N steps flagged — review at milestone`.
  - 🔴 → do **not** proceed; raise the approval overlay / prompt: `🔴 <reason> — [v]iew / [a]ccept / [s]teer`.
  - Store `confidence` on the gate row.
- **See it work:** three snapshots — a 🟢 run (quiet), a 🟡 run (footer note), a 🔴 run (prompt appears).
- **Done when:** each tier drives the right behavior.

### M6.3 — Log every factor + record your overrides · ~3h · needs: M6.2

- **Goal (plain):** save the raw factors and whatever you decide at a 🔴/🟡.
- **Why:** this is your future training data to tune thresholds (the "iterate and check what works" path).
- **Build:**
  - Ensure `factors_json` has every factor. Add `user_signals (id, gate_id, action, at)`; on an override write `accept`/`reject`/`steer`.
- **See it work:** override a 🔴 → a `user_signals` row appears joined to the gate.
- **Done when:** overrides are captured with the gate they refer to.

---

## Stage 7 — Close the loop to Minima

_By the end of this stage grounded outcomes flow back so Minima learns which model actually succeeded._

### M7.1 — Write the grounded outcome onto the routing record · ~4h · needs: M6.2

- **Goal (plain):** stamp each step's real result onto the routing decision that picked the model.
- **Why:** turns "the judge guessed 0.7" into "the test passed" — the feedback gap you set out to fix.
- **Build:**
  - Join the step's gate to its `routing_decisions` row (by rec_id); write `outcome`, `verified_by`, `confidence`.
- **See it work:** `SELECT model, outcome, verified_by FROM routing_decisions` after a run → grounded outcomes attached to the right model.
- **Done when:** every verified step updates its routing record.

### M7.2 — Feed it into the existing feedback path (deterministic outranks judge) · ~3h · needs: M7.1

- **Goal (plain):** send the grounded result through the same feedback call you already have, and prefer it over the judge.
- **Why:** this is the reward-signal decision — a real check beats an opinion.
- **Build:**
  - In the feedback step (`runtime.ts`, reuse `feedbackSafely`), if a deterministic outcome exists, use it (full weight) and skip/deprioritize the LLM-judge; else fall back to the judge.
- **See it work:** log/mock the feedback payload → a verified step sends `verified_by=deterministic`, weight ~1.0; an unverifiable step falls back to the judge.
- **Done when:** deterministic results are the ones that reach Minima when present.

### M7.3 — A failed verification feeds the recovery ladder · ~4h · needs: M7.1

- **Goal (plain):** when a check fails, reuse your existing escalation to try a stronger model.
- **Why:** you already have this ladder for judge-failures — now feed it a _grounded_ trigger, and log the loss for the model that failed.
- **Build:**
  - On a 🔴 check-fail, call the existing recovery path (exclude current model, re-route to next rung) and write `routing_decisions(outcome='failure')` for the failed model, `success` for the rung that fixes it.
- **See it work:** a step that model A fails → snapshot/log shows re-route to model B; DB shows failure@A + success@B.
- **Done when:** grounded failures escalate and are recorded per model.

---

## Stage 8 — Watch it, replay it

_By the end of this stage you can inspect any run and demo the whole thing._

### M8.1 — `/why` shows per-step verification · ~4h · needs: M6.2

- **Goal (plain):** a command that lists each step with its check, tier, reason, and any drift.
- **Why:** your window into _why_ the system did what it did.
- **Build:** `/why` reads `plan_steps` + `gates` + `file_changes` and renders a compact per-step table (`✓ step 3 🟡 self-written test`, `⚠ drift: billing/stripe.ts`).
- **See it work:** run a mixed task, then `/why` → snapshot shows the per-step verdicts.
- **Done when:** `/why` reflects the ledger exactly.

### M8.2 — End-to-end demo + acceptance artifact · ~4h · needs: all above

- **Goal (plain):** one scripted run that exercises 🟢, 🟡, 🔴, drift, and escalation, captured as a snapshot + DB dump.
- **Why:** proves the spine works end-to-end and becomes your regression test.
- **Build:**
  - A scripted plan (fixtures) hitting each path; a test that runs it under PTY, captures the strip snapshot, and dumps `plan_steps`/`gates`/`routing_decisions` for assertions.
- **See it work:** `bun test` runs the demo; the snapshot shows step progress + 🟡 note + 🔴 prompt + DRIFT, and the DB dump has grounded outcomes.
- **Done when:** the demo is green and pinned as a regression check.

---

## 5. Definition of done for the whole spine

You've built the ground-truth verification & feedback spine when, behind `MINIMA_TUI_GROUND_TRUTH=1`:

1. The agent's plan is **persisted, projected back each turn, and visible** in the footer.
2. Every file write is **attributed to a step**, and off-plan writes show **DRIFT**.
3. A step **cannot be marked done** unless its check goes **red→green**.
4. Each verification records **provenance, coverage, tamper** and a **confidence tier**.
5. 🟢 glides silently, 🟡 glides with a flag, 🔴 stops and asks — and your overrides are **logged**.
6. Grounded outcomes flow to Minima, **outranking the judge**, and failures **escalate** via the existing ladder.
7. `/why` explains any run, and a **scripted demo** exercises every path in `bun test`.

---

## 5b. Splitting the remaining build across two engineers

The work left (Stages 3–8) is essentially **one long dependency chain** — M3 → M4 → M5 → M6 → M7 → M8. If you split it by MP _number_, the two engineers just take turns and one always waits on the other. The trick is to split by **seam**: one engineer _produces_ verification facts, the other _consumes_ them, and they meet at a single typed contract — the shape of `gates.factors_json`.

### Step 0 — freeze the contract together (day 1, ~1h) · ✅ Done

**Status: implemented.** The contract lives in **`src/minima/gt_contract.ts`** — a pure, dependency-free types module (zero runtime imports) that both tracks and the DB boundary import from, so the enum spellings can never drift apart. Each string enum is declared once as an `as const` tuple with its union _derived_ from it, so the allowed set is frozen at **both** compile time (the union) and runtime (the array) — and is regression-guarded + round-tripped through the DB by `tests/gt-contract.test.ts`.

Exported surface:

```ts
// frozen value set (as const)                              → derived union
GATE_OUTCOMES    = ["verified", "failed", "unrunnable"]     → GateOutcome
CONFIDENCE_TIERS = ["green", "yellow", "red"]               → ConfidenceTier
VERIFIED_BY      = ["deterministic", "judge", "user"]       → VerifiedBy
GATE_KINDS       = ["step_check", "milestone"]              → GateKind
BASELINES        = ["red", "green", "unrunnable"]           → Baseline      (M3.3)
USER_ACTIONS     = ["accept", "reject", "steer"]            → UserAction    (M6.3)
CHECK_ORIGINS    = ["pre_existing", "agent_new", "user"]    → CheckOrigin   (M5.1)

interface Factors {           // Track A fills this → gates.factors_json → Track B reads it
  pass: boolean;              // check result                 (M3.2 / M4.1)
  redToGreen: boolean;        // baseline red && now green    (M4.2)
  hasCheck: boolean;          // writing step w/ no check → 🟡 (M6.1)
  checkOrigin: CheckOrigin;   // provenance                   (M5.1)
  coverageHit: boolean | "unknown"; // coverage               (M5.2)
  tamper: boolean;            // tests weakened/deleted        (M5.3)
}
interface ConfidenceVerdict { tier: ConfidenceTier; reason: string }         // confidence() output (M6.1)
interface CheckResult { pass: boolean; output: string; durationMs: number }  // runCheck() output   (M3.2)
```

**Retrofit:** `src/db/minima_db.ts` now consumes these unions at the DB boundary (via `import type`, so no runtime dependency and no import cycle): `GateRow`, `insertGate(...)`, `recordUserSignal(...)`, `attachGroundedOutcome(...)`, `setStepBaseline(...)`, `insertStep(...)`, and `PlanStepRow.baseline` are typed to the frozen enums instead of bare `string`. Plan/step `status` is deliberately left as `string` — it flows through `parseTodos`/`TodoInput` and isn't a verification enum.

> **Decision record.** _Where:_ `src/minima/gt_contract.ts` (new), consumed by `src/db/minima_db.ts`; tests in `tests/gt-contract.test.ts`. _Scope:_ types + a conservative DB-boundary retrofit (verification enums only). _Frozen on:_ branch `feat/plan-sqlite-merge`. _Rules:_ do **not** widen these unions back to `string`; to add a value, extend the `as const` tuple (its union updates automatically) and the matching test. New **columns** → append migration **v6** (never edit v1–v5).

### Track A — "the check engine" (producer) · the critical path

Owns everything that **runs checks and computes raw factors**.

- **MPs:** M3.1, M3.2, M3.3, M4.1, M4.2, M4.3 → then M5.1, M5.2, M5.3.
- **Files:** new `src/minima/check.ts` (`runCheck`), the agent loop's `beforeToolCall`/`afterToolCall` seams, `src/minima/ground_truth.ts` (factor computation), and the `minima_db.ts` writers (already there).
- **Deliverable:** every step that finishes (or fails) writes a `gates` row with a **fully-populated `factors_json`** conforming to the contract.

### Track B — "trust, UI & learning" (consumer)

Owns everything that **reacts to a gate**. Track B already owns the footer/overlay from M1.3/M2.3, so it keeps the UI.

- **MPs:** M6.1 (confidence fn) and M8.1 (`/why`) can start **on day 1** — build them test-first against the `Factors` type and against `/gt-seed`-style seeded rows, before Track A has produced a single real gate. Then M6.2, M6.3, M7.1 (logic), M7.2, M7.3.
- **Files:** new `src/minima/confidence.ts` (pure fn), `src/tui/app.tsx` (footer note + 🔴 overlay), `src/minima/runtime.ts` (feedback + recovery, reuse `feedbackSafely`), and the `/why` command.
- **Deliverable:** given a `factors_json`, the system tiers it 🟢🟡🔴, drives the UI, captures overrides, and feeds Minima + the recovery ladder.

### Why this parallelizes

Track B's hardest pieces — the confidence rule ladder (M6.1), `/why` (M8.1), and the tier→behavior UI (M6.2) — depend only on the **contract**, not on Track A's internals. B builds and unit-tests them against mocked/seeded factor rows while A is still building the producer. The two tracks only truly converge when A lands **M4.3** (the first real gate rows), at which point B swaps mocks for live data.

### Sync points

1. **Day 1** — freeze the `Factors` type + enums together (30–60 min). Commit it first.
2. **When A lands M4.3** — B switches from seeded/mock factors to real gate rows; smoke-test the step→gate→UI join end-to-end.
3. **M8.2** — build the demo together: A supplies the scripted-run fixtures that hit 🟢/🟡/🔴/drift/escalation; B asserts the strip snapshot + DB dump.

### Rough sequencing (guide's own per-MP estimates)

| Wk  | Track A (producer)               | Track B (consumer)                         | Milestone                                                     |
| --- | -------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| 1   | M3.2 + M3.1 + M3.3 (~10h)        | M6.1 + M8.1 scaffold (~8h)                 | verifiable baseline + tierer + inspector shell                |
| 2   | M4.1 + M4.2 + M4.3 (~10h)        | wire M6.2 against gates as they land (~4h) | **red→green gate enforced end-to-end**                        |
| 3   | M5.1 + M5.2 + M5.3 (~11h)        | M6.2 finish + M6.3 + M7.1 (~10h)           | full factors + confidence-driven behavior + grounded outcomes |
| 4   | help M7.2/M7.3 + hardening (~7h) | M7.2 + M7.3 + M8.1 finish (~8h)            | learning loop closed                                          |
| 4   | **M8.2 demo together (~4h)**     |                                            | demo pinned as regression                                     |

≈60–70h of build (the guide's summed MP estimates) → roughly **3–4 calendar weeks for two engineers** including review overhead.

### Rules of the road (unchanged)

- One MP per PR; every PR keeps **`bun test` green** _and_ **`tsc --noEmit` clean** (`bun run check`).
- Everything stays behind `MINIMA_TUI_GROUND_TRUTH` (off by default) — `main` stays shippable after every merge.
- Both tracks touch `ground_truth.ts` and `minima_db.ts` (different functions, same files) — **rebase Track B onto Track A's merges** frequently rather than letting the branches diverge.

---

## 6. Notes for later (don't build yet)

- **Confidence tuning:** once M6.3 has logged real overrides, analyze which factor combos you kept overriding, then either loosen/tighten the M6.1 rules or graduate the 🟢↔🟡 boundary to a small learned score. Add a **trust ramp** (after N clean `agent_new` verifications on a task type, let it reach 🟢).
- **Real coverage:** replace the M5.2 grep heuristic with actual line-coverage when you have time.
- **Steps with no possible check:** for genuinely uncheckable steps, cap at 🟡 and lean on drift + milestone review rather than pretending you verified them.

> **Suggested cadence:** one MP per PR, each keeping `bun test` green. Stages 0–2 first give you a _watchable_ demo you can show off; Stages 3–6 give you the _verifiable_ core; Stages 7–8 close the learning loop.
