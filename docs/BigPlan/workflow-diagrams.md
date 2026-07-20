# Big Plan — Workflow Diagrams

> How the **Big Plan** (Ground-Truth Core) loop actually runs: the agent writes a plan,
> does the work, and **the harness checks each step really happened before letting it move on.**
> Every verdict lands in one small SQLite **ledger** that two readers consume — the **screen**
> (so you can watch) and **Minima** (so it learns which model actually succeeded).
>
> Design source of truth: [`docs/PLAN/ground-truth-plan.md`](../PLAN/ground-truth-plan.md) ·
> Everything here is behind the flag `MINIMA_TUI_GROUND_TRUTH` (off by default).

---

## The one-sentence model

> A plan step is only **done** when its own `verify` command goes **red → green because of
> this step's code** — and a confidence tier (🟢 / 🟡 / 🔴) decides whether the agent glides on
> silently, glides with a flag, or stops and asks.

### Reading key

| Symbol | Meaning |
|---|---|
| 🟢 **green** | Verified. Agent marks the step done and **glides on silently**. |
| 🟡 **yellow** | Went green, but something is soft (no check, agent-authored check, unknown coverage). Done **with a flag**. |
| 🔴 **red** | Check failed **or** tampering detected. Done is **blocked** — stop and ask; the recovery ladder escalates. |
| **DRIFT** | A file was written that **no plan step claimed** — surfaced in the footer, not hidden. |
| **The ledger** | One SQLite DB: `plans` · `plan_steps` · `file_changes` · `gates` · `user_signals`. |

### The confidence factors (what the gate computes)

`pass` (check result) · `redToGreen` (was red, now green) · `hasCheck` (a writing step with no
check → 🟡) · `checkOrigin` (`pre_existing` / `agent_new` / `user`) · `coverageHit` · `tamper`
(tests weakened or deleted → forces 🔴).

---

## Diagram 1 — General workflow

The reusable loop. It runs once per task, iterating the middle box once per plan step.

```mermaid
flowchart TD
    Start(["Task starts<br/>flag: MINIMA_TUI_GROUND_TRUTH=1"])

    subgraph P1["① Plan — capture and project"]
        Plan["Agent writes plan via todowrite<br/>every step names a verify command"]
        Persist["Persist to ledger:<br/>plans + plan_steps"]
        Project["Re-inject plan every turn<br/>footer strip: step X / N"]
        Plan --> Persist --> Project
    end

    subgraph P2["② Per-step loop — do and verify"]
        InProg["Step → in_progress"]
        Base["Capture baseline<br/>runCheck(verify) → red / green / unrunnable"]
        Work["Agent does the work (edits files)"]
        Claim{"Path claimed<br/>by this step?"}
        Rec["Record in file_changes"]
        Drift["Footer: DRIFT"]
        Done["Agent calls set_status(done)"]
        Gate["Harness intercepts →<br/>runCheck(verify) again"]
        Fac["Compute Factors:<br/>pass · redToGreen · hasCheck<br/>checkOrigin · coverageHit · tamper"]
        Conf{"confidence(Factors)"}
        InProg --> Base --> Work --> Claim
        Claim -->|yes| Rec
        Claim -->|no| Drift
        Rec --> Done
        Drift --> Done
        Done --> Gate --> Fac --> Conf
    end

    Green["🟢 allow done — glide silently"]
    Yellow["🟡 allow done — with a flag"]
    Red["🔴 BLOCK done — stop and ask<br/>recovery ladder escalates"]

    Ledger[("THE LEDGER — one SQLite DB<br/>plans · plan_steps · file_changes<br/>gates · user_signals")]
    Screen["SCREEN — you watch<br/>footer strip · /why"]
    Minima["MINIMA — it learns<br/>grounded outcome outranks the judge"]

    Start --> Plan
    Project --> InProg
    Conf -->|green| Green
    Conf -->|yellow| Yellow
    Conf -->|red| Red
    Green --> Ledger
    Yellow --> Ledger
    Red --> Ledger
    Ledger --> Screen
    Ledger --> Minima
    Green -.->|next step| InProg
    Yellow -.->|next step| InProg
    Red -.->|after fix / steer| InProg
```

**How to read it, phase by phase:**

1. **Plan.** The agent emits a plan (`todowrite`); each step carries a `verify` command. The plan
   is written to the ledger and **re-injected into context every turn** so it survives scroll and
   compaction — the footer shows `step X / N`.
2. **Per-step loop.** When a step goes `in_progress`, the harness runs its check once to record a
   **baseline** (red / green / unrunnable). The agent works; every file write is **attributed to
   the step**, and any unclaimed write shows **DRIFT**. When the agent tries `set_status(done)`,
   the harness **intercepts**, re-runs the check, and computes the confidence **factors**.
3. **Tier → behavior.** 🟢 glides silently, 🟡 glides with a flag, 🔴 blocks and asks. Either way a
   `gates` row is written.
4. **Two readers.** The ledger feeds the **screen** (you watch; `/why` explains any step) and
   **Minima** (grounded outcomes flow into routing and **outrank the LLM judge**; failures
   escalate the model via the recovery ladder).

---

## Diagram 2 — Worked example

**Scenario:** *"Harden the `/login` endpoint."* The agent produces a 3-step plan. The run below
deliberately hits all three tiers — a clean pass (🟢), a soft pass (🟡), and a blocked step (🔴) —
plus a DRIFT event.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as You
    participant A as Agent
    participant H as Harness / Gate
    participant L as Ledger
    participant S as Screen
    participant M as Minima

    Dev->>A: "Harden the /login endpoint"
    A->>H: todowrite — 3-step plan, each step has a verify cmd
    H->>L: insert plans + plan_steps
    L-->>S: footer shows "step 0 / 3"

    Note over A,H: Step 1 — Reject empty password<br/>verify pytest -k empty_password
    A->>H: set_status(in_progress)
    H->>H: runCheck → RED (baseline: test fails)
    A->>A: edit auth.py
    H->>L: file_changes: auth.py → step 1
    A->>H: set_status(done)
    H->>H: runCheck → GREEN · redToGreen=true · tamper=false
    H->>H: confidence → 🟢 green
    H->>L: gates: verified (silent)
    L-->>S: step 1 / 3 ✓
    L-->>M: grounded outcome verified → routing

    Note over A,H: Step 2 — Add rate-limit (429 after 5 tries)<br/>verify pytest -k rate_limit
    A->>H: set_status(in_progress) → baseline RED
    A->>A: edit auth.py  and  edit README.md
    H->>L: file_changes: auth.py → step 2
    H-->>S: DRIFT — README.md claimed by no step
    A->>H: set_status(done)
    H->>H: runCheck → GREEN · but checkOrigin=agent_new
    H->>H: confidence → 🟡 yellow
    H->>L: gates: verified (flagged)
    L-->>S: step 2 / 3 ✓  ⚠ unverified-origin

    Note over A,H: Step 3 — Refactor session store<br/>verify pytest -k session
    A->>H: set_status(in_progress) → baseline RED
    A->>A: edit session.py  and  weaken a test assertion
    A->>H: set_status(done)
    H->>H: runCheck → GREEN · but tamper=true
    H->>H: confidence → 🔴 red
    H-->>A: BLOCK done — stop and ask
    H->>L: gates: failed
    L-->>S: 🔴 step 3 blocked — tests weakened
    H->>M: failure → recovery ladder escalates the model
    Dev->>A: steer / approve a real fix
```

**Walking the example:**

| Step | Baseline | Work | Gate re-check | Factors that mattered | Tier | Outcome |
|---|---|---|---|---|---|---|
| **1 · Reject empty password** | 🔴 red (test fails) | edits `auth.py` | 🟢 green | `redToGreen=true`, `tamper=false` | 🟢 | Marked done **silently**; Minima logs a *verified* win for the model. |
| **2 · Add rate-limit** | 🔴 red | edits `auth.py` **+** `README.md` | 🟢 green | `checkOrigin=agent_new` (agent wrote its own check); `README.md` unclaimed → **DRIFT** | 🟡 | Done **with a flag** — went green, but the harness can't fully trust an agent-authored check, and it noticed off-plan work. |
| **3 · Refactor session store** | 🔴 red | edits `session.py` **+** weakens a test | 🟢 green | `tamper=true` (assertion removed) | 🔴 | **Blocked.** A green that came from gutting a test isn't a green. The agent stops and asks; Minima escalates. |

The lesson the example makes concrete: **the check passing is necessary but not sufficient.** Big
Plan asks *why* it passed — was it red first, who wrote the check, did the tests get weaker — and
only a step that survives all of that glides through untouched.

---

## Where this lives in the build

The loop is built bottom-up in stages (see [`ground-truth-plan.md`](../PLAN/ground-truth-plan.md) §3):

```
Stage 0  DB + flag           ─┐
Stage 1  persist the plan    ─┼──►  SEE the plan on screen (footer strip)   ← Diagram 1, phase ①
Stage 2  record file changes ─┘     ...and see DRIFT when work goes off-plan

Stage 3  the verify spec     ─┐
Stage 4  red→green gate       ─┼──►  a step can't be "done" unless a real check passes  ← Diagram 1, phase ②
Stage 5  provenance + tamper ─┘

Stage 6  confidence 🟢🟡🔴    ─────►  near-zero interruptions (only stops when it must)
Stage 7  feedback loop        ─────►  Minima learns from grounded outcomes   ← Diagram 1, "two readers"
Stage 8  /why + demo          ─────►  you can watch and replay the whole thing
```

Stages 0–2 make it **watchable**, 3–5 **verifiable**, 6 **quiet**, 7 **learns**, 8 **inspectable**.
