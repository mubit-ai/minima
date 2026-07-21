# Playbook — Writing a Plan That Actually Executes

> Actionable version of `characteristics-of-successful-plans.md`. Use this when you're about
> to write a plan for an agent (yourself, a Claude Code session, a Minima Big Plan run, a
> multi-agent system). It contains: a pre-flight checklist, a plan template, a scoring rubric,
> and four worked anti-patterns.

---

## Part 1 — Pre-flight checklist (before you write a single step)

Answer all seven. If you can't answer one, stop and resolve it — don't write steps yet.

| # | Question | Why it matters | Property |
|---|---|---|---|
| 1 | What is the **observable end state** that means "done"? | Without this you have a direction, not a goal. | §7 stop |
| 2 | What **tools** are available, and which can in principle produce what you need? | An agent searching the web for Slack-only info is doomed from the start. | §6 tools |
| 3 | How **complex** is this — lookup, comparison, investigation? | Effort must scale to complexity; underbudgeting tokens is the #1 failure cause. | §3 effort |
| 4 | Where will the plan be **stored** so it survives context truncation? | Plans held only in context get silently amputated on truncation. | §4 persist |
| 5 | When should the agent **replan** vs. push through? | Static plans fail when the environment surprises. | §5 replan |
| 6 | What is the **iteration cap** and the **escalation trigger**? | Without caps, failures spiral; without escalation, "ask the human" never happens. | §7 stop |
| 7 | Who/what **observes** the plan during execution? | Plans that aren't visible can't be course-corrected. | §4 visible |

---

## Part 2 — The plan template

Copy this. Fill it in. If a field is hard to fill, that *is* the signal — the plan isn't ready.

```yaml
# ───────────────────────────── HEADER ─────────────────────────────
name: <short, declarative>
goal: |
  <one paragraph: the observable end state. If a stranger can't tell when this
  is finished, rewrite it.>

# Effort budget — calibrated to complexity (§3)
effort:
  shape: lookup | comparison | investigation | build      # pick one
  agents: <int, e.g. 1 / 2-4 / 10+>                        # 0 for single-agent
  tool_calls_per_step: <int>
  tokens: <approx budget, or "uncapped w/ cap: N">
  time: <hard deadline>

# Stop conditions — non-optional (§7)
done:     <observable check — test passes, file exists, exit code 0, etc.>
cap:      <max iterations / tool calls / tokens before force-stop>
escalate: <condition that triggers "stop and ask" — e.g. "verify fails twice">

# Persistence + visibility (§4)
store:      <DB / file / memory key — must survive context truncation>
re-project: every-turn | on-demand
observer:   <human-in-loop | harness | log-only>

# Replan policy (§5)
replan: after-each-step | on-evidence:<kind> | never
#  ^ almost never "never" outside deterministic workflows

# ───────────────────────────── STEPS ──────────────────────────────
# Each step MUST have: objective, tools, verify. (§1, §2, §6)
steps:
  - id: 1
    objective: |
      <one sentence, concrete. What changes in the world when this is done?>
    tools: [<tool>, <tool>]            # §6 — must be capable of producing `verify`'s check
    verify: <command or observable>     # §1 — red→green signal. If empty, keep decomposing.
    depends_on: []                      # step ids that must be done first
    notes: |
      <boundary from sibling steps — what's in scope, what's NOT. Prevents
      duplicate work and gaps. (§2)>
    budget:
      tool_calls: <int>
      tokens: <approx>

  - id: 2
    # ...

# ─────────────────────────── ANTI-SPIRAL ──────────────────────────
# What "off-plan" looks like, so drift is detectable (§4)
off_plan_signal:
  - <e.g. "writing files outside src/feature-x/">
  - <e.g. "calling tools not named in any step's `tools`">
```

---

## Part 3 — Per-step quality checklist

For **every** step, before you commit it:

- [ ] **Objective is concrete.** "Refactor the auth module" ✗. "Extract token validation into
  `auth/tokens.py`, no behavior change, all existing auth tests still pass" ✓.
- [ ] **Verify is filled in.** A command, a checkable artifact, or an observable state. If you
  wrote "done when implemented", delete it and try again. (§1)
- [ ] **Tools are named and capable.** Each tool in `tools` can in principle produce what
  `verify` checks. (§6)
- [ ] **Boundary is explicit.** You can say what this step does *not* do, and that scope is
  different from every sibling. (§2)
- [ ] **Dependency is honest.** If `depends_on` is wrong, parallel steps will race or
  dead-end.
- [ ] **Budget is finite.** `tool_calls` and `tokens` are integers, not "enough".

---

## Part 4 — Plan scoring rubric

Score the finished plan 0–2 on each property. Anything below 11/14 is not ready to execute.

| Property | 0 — missing | 1 — partial | 2 — strong |
|---|---|---|---|
| §1 Verifiable steps | no `verify` on most steps | some steps checkable | every step has a red→green signal |
| §2 Right-sized decomposition | all-steps-one-blob OR micro-steps | steps differ in granularity | uniform, each with objective+format+tools+boundary |
| §3 Effort scales to complexity | no budget anywhere | budget present but unjustified | budget calibrated to a named `shape` |
| §4 Persistent + visible | lives only in the prompt | stored, not projected | stored + projected every turn + drift-detectable |
| §5 Replan policy | implicit "follow the plan" | replan allowed but undefined | replan trigger is explicit |
| §6 Tool/task match | tools unspecified | tools named, not sanity-checked | tools named AND each can produce `verify`'s check |
| §7 Stop conditions | no caps, no escalation | cap OR escalation | `done` + `cap` + `escalate` all present |

**Total: ___ / 14.** Cutoff for execution: **11**. Below that, the plan is a wish.

---

## Part 5 — Four anti-patterns (and the fix)

### A. The monolith
```
goal: "Build the auth feature"
steps:
  - id: 1
    objective: "Build the auth feature"
```
**Diagnosis**: §2 violated. One blob.
**Fix**: Keep decomposing until each step has its own `verify`. If you can't write `verify`,
you don't actually know what the step produces — keep splitting.

### B. The wishful plan
```
steps:
  - id: 1
    objective: "Set up the database"
    verify: ""    # ← empty
```
**Diagnosis**: §1 violated. No verified evidence.
**Fix**: For "set up the database", `verify` is `sqlite3 minima.db ".schema plans"` returning
non-empty, or a migration test going red→green. The `verify` field is the step's actual
contract — write it first, then the objective.

### C. The railroad
```
replan: never
```
**Diagnosis**: §5 violated. The plan is a script.
**Fix**: Default is `after-each-step` or `on-evidence:<kind>`. Reserve `never` for fully
deterministic workflows where inputs are known up front (rare).

### D. The open loop
```
done: ""
cap: ""
escalate: ""
```
**Diagnosis**: §7 violated. No termination criteria.
**Fix**: Write `done` first — it forces you to define the goal. Then `cap` (the safety net)
and `escalate` (the "ask for help" valve). All three are non-optional; an agent without them
either stops too early or spirals.

---

## Part 6 — How Minima's Big Plan implementation operationalizes this

Minima's Big Plan contract maps directly onto the seven properties. Use this as a worked
example of the playbook in production:

| Playbook property | Minima Big Plan mechanism |
|---|---|
| §1 Verifiable steps | `plan_steps.verify` column + frozen Big Plan contract (`big_plan_contract.ts`); step is done only if check went red→green because of this step's code |
| §2 Right-sized decomposition | `todowrite` is the unit of decomposition; each step persisted via `upsertPlanFromTodos` |
| §3 Effort scales to complexity | per-step `tool_calls` / token accounting attributed through the step id |
| §4 Persistent + visible | `plans` / `plan_steps` tables (stage 0–1) + step X/N footer + DRIFT indicator (stage 2) |
| §5 Replan policy | new `todowrite` calls upsert the plan; the agent can rewrite remaining steps |
| §6 Tool/task match | the harness attributes each tool call / file write to an in-progress step; off-plan writes show DRIFT |
| §7 Stop conditions | confidence tiers 🟢/🟡/🔴 → silent / flag / stop-and-ask |

If you're modifying the Big Plan implementation, the playbook above is the *why* behind the contract. Don't
weaken a property without re-reading the corresponding section in
`characteristics-of-successful-plans.md`.
