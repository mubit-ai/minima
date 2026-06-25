# `/goals` — Implementation Plan

A cost-aware goal/plan feature for the Minima harness. Two phases: **Phase 1** delivers
table-stakes goal + task tracking (the mechanism); **Phase 2** adds Minima's differentiator —
goal-conditioned routing and cost-to-goal budgeting.

Researched against how Claude Code (TodoWrite → Task tools, plan mode), OpenCode, Cline
(Focus Chain), Cursor/Windsurf (plan.md, dual-model), and GitHub Spec Kit handle goals. The
field converged on: a structured todo list the agent maintains + re-anchoring it each step as
a "north star". Minima's unique angle is **cost** — framing a goal as a budget, which no other
agent does.

## Data model — `src/minima_harness/minima/goals.py` (new)

```python
@dataclass
class GoalTask:
    id: str                 # short slug
    content: str            # imperative ("Add OAuth login")
    active_form: str        # present-continuous ("Adding OAuth login")
    status: str             # pending | in_progress | completed | blocked
    est_cost_usd: float = 0.0    # routing estimate captured when worked (Phase 2)
    actual_cost_usd: float = 0.0 # realized cost attributed to this task (Phase 2)

@dataclass
class Goal:
    title: str
    tasks: list[GoalTask]
    task_type: str | None = None     # feeds the router (Phase 2)
    tags: list[str] = field(default_factory=list)
    budget_usd: float | None = None  # optional cost ceiling (Phase 2)
    started_ts: float = 0.0
    done: bool = False
    # progress() -> (done, total); active() -> the in_progress GoalTask | None

class GoalStore:
    """Owns the active Goal, (de)serializes it, persists to + loads from the session."""
```

**Where state lives:** the existing per-cwd session JSONL, via a new `EntryType.GOAL`
(`session/format.py`) whose payload is the serialized `Goal`. Latest `GOAL` entry wins → survives
`--continue`/`--resume` for free. Phase 2 adds an opt-in Mubit mirror for cross-session recall.

## Phase 1 — goal + task tracking (table-stakes)

1. **`tasks` tool** (`tools/tasks.py`, factory `tasks_tool(store)` added to the app's toolset):
   `op: set|update|list`. System-prompt guidance mirrors the converged norm — use for 3+ step
   work, exactly one `in_progress`, mark `completed` only when verified.
2. **`/goals` command** (`app.py`): `/goals` opens `GoalsOverlay` (new modal, `overlays.py`) with
   `●/○/✓` + `N/M`; `/goals set <title>` starts one; `/goals clear` ends it.
3. **System-prompt re-anchor**: append the active goal + open tasks to the system prompt every
   turn (`_apply_effective_prompt` called from `run_turn`) — the Focus-Chain "north star".
4. **Footer progress**: a `goal: 3/8` segment in `_footer_state` + `render_footer`, only when
   a goal is active.
5. **Anti-drift / anti-over-plan**: re-anchor each turn (#3); 3+-step heuristic in the tool prompt.

Files: `minima/goals.py` (new), `tools/tasks.py` (new), `tools/builtin.py`, `session/format.py`,
`tui/overlays.py`, `tui/app.py`, `tui/mubit.py`/context, footer widget.

## Phase 2 — cost-aware goals (Minima's moat)

6. **Goal-conditioned routing**: when a goal is active, `run_turn` passes the goal's
   `task_type`/`tags` into `agent.prompt(text, task_type=…)` → `recommend(...)`, so the whole goal
   routes coherently and Mubit clusters by goal. (Minima's analogue of Windsurf's
   big-model-plans / cheap-model-executes split, at the routing layer.)
7. **Cost-to-goal**: attribute each turn's `CostRow` to the `in_progress` task; spent = Σ actual
   since `started_ts`; projected = Σ `est_cost_usd` of pending tasks (or Mubit recall of similar
   past goals); optional `budget_usd` warns (not blocks). Surface `└ goal: spent $Y / ~$Z
   projected (budget $B)` under the cost line.
8. **Mubit cross-session goals (opt-in)**: mirror a completed goal to Mubit; `recall("goal: …")`
   resumes it and seeds realized-cost priors. Fail-open.

Files: `tui/app.py`, `minima/meter.py`, `minima/goals.py`, `tui/mubit.py`.

## Sequencing & risk
- Phase 1 fully, then Phase 2 (depends on the Goal/task model). Both gated on a goal being
  active → zero behavior change when none is set.
- Riskiest: cost-to-goal attribution when the model doesn't cleanly mark one task `in_progress`
  → attribute to the goal as a whole; ship spent/projected before per-task breakdown.
- Gates each phase: `pytest -m "not live"` + ruff + mypy green.
