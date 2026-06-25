"""Goal / task tracking for the harness — the data model behind ``/goals``.

A :class:`Goal` is a high-level objective plus a checklist of :class:`GoalTask` items the agent
maintains as it works (one ``in_progress`` at a time). Phase 1 uses this purely to keep the
agent on-track and show progress; Phase 2 adds cost fields (``est_cost_usd`` / ``actual_cost_usd``
/ ``budget_usd``) so a goal can be tracked against a budget — Minima's differentiator.

State is owned by :class:`GoalStore`, which (de)serializes to the per-session store so a goal
survives ``--continue`` / ``--resume``.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

_STATUSES = ("pending", "in_progress", "completed", "blocked")


def _slug(text: str, n: int = 24) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:n].rstrip("-")) or "task"


@dataclass
class GoalTask:
    id: str
    content: str  # imperative form ("Add OAuth login")
    active_form: str = ""  # present-continuous ("Adding OAuth login"); falls back to content
    status: str = "pending"  # pending | in_progress | completed | blocked
    est_cost_usd: float = 0.0  # routing estimate captured while worked (Phase 2)
    actual_cost_usd: float = 0.0  # realized cost attributed to this task (Phase 2)

    @property
    def label(self) -> str:
        if self.status == "in_progress" and self.active_form:
            return self.active_form
        return self.content

    @classmethod
    def make(cls, content: str, active_form: str = "", status: str = "pending") -> GoalTask:
        status = status if status in _STATUSES else "pending"
        return cls(id=_slug(content), content=content, active_form=active_form, status=status)


@dataclass
class Goal:
    title: str
    tasks: list[GoalTask] = field(default_factory=list)
    task_type: str | None = None
    tags: list[str] = field(default_factory=list)
    budget_usd: float | None = None
    started_ts: float = 0.0
    done: bool = False
    # Cost attributed to turns that ran while no task was in_progress (Phase 2).
    spent_extra_usd: float = 0.0

    def progress(self) -> tuple[int, int]:
        """(completed, total)."""
        return (sum(1 for t in self.tasks if t.status == "completed"), len(self.tasks))

    def active(self) -> GoalTask | None:
        return next((t for t in self.tasks if t.status == "in_progress"), None)

    def routing_signals(self) -> tuple[str | None, list[str]]:
        """(task_type, tags) to feed the router so a goal's turns cluster + route coherently."""
        tags = list(self.tags)
        if self.title:
            tags = [f"goal:{_slug(self.title)}", *tags]
        return self.task_type, tags

    def record_turn_cost(
        self, actual_usd: float, est_usd: float, newly_completed_ids: list[str] | None = None
    ) -> None:
        """Attribute a turn's realized cost. Order of preference:

        1. the in_progress task (the model marked one — ideal);
        2. else split evenly across tasks that flipped to completed THIS turn (the common case
           where a model batches: plan → do the work → mark several done at once);
        3. else the goal at large (``spent_extra_usd``), so goal-level spend is always accurate.
        """
        task = self.active()
        if task is not None:
            task.actual_cost_usd += actual_usd
            if task.est_cost_usd == 0.0:
                task.est_cost_usd = est_usd
            return
        targets = [t for t in self.tasks if t.id in (newly_completed_ids or [])]
        if targets:
            share_a, share_e = actual_usd / len(targets), est_usd / len(targets)
            for t in targets:
                t.actual_cost_usd += share_a
                if t.est_cost_usd == 0.0:
                    t.est_cost_usd = share_e
            return
        self.spent_extra_usd += actual_usd

    def spent_usd(self) -> float:
        return sum(t.actual_cost_usd for t in self.tasks) + self.spent_extra_usd

    def projected_total_usd(self) -> float | None:
        """Linear extrapolation of total goal cost from progress (None until ≥1 task done)."""
        done, total = self.progress()
        if done <= 0 or total <= 0:
            return None
        return self.spent_usd() / done * total

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Goal:
        tasks = [GoalTask(**t) for t in data.get("tasks", [])]
        return cls(
            title=data.get("title", ""),
            tasks=tasks,
            task_type=data.get("task_type"),
            tags=list(data.get("tags", [])),
            budget_usd=data.get("budget_usd"),
            started_ts=float(data.get("started_ts", 0.0)),
            done=bool(data.get("done", False)),
            spent_extra_usd=float(data.get("spent_extra_usd", 0.0)),
        )


class GoalStore:
    """Owns the active goal and (de)serializes it to/from the session store.

    The session store is the single source of truth: :meth:`save` appends a GOAL entry and
    :meth:`load` reads the latest one, so a goal survives resume with no extra storage.
    """

    def __init__(self, goal: Goal | None = None) -> None:
        self.goal = goal

    @property
    def active(self) -> bool:
        return self.goal is not None and not self.goal.done

    # ---- mutation (driven by the `tasks` tool and the /goals command) ----
    def start(self, title: str, *, now: float = 0.0) -> Goal:
        self.goal = Goal(title=title, started_ts=now)
        return self.goal

    def clear(self) -> None:
        if self.goal is not None:
            self.goal.done = True

    def set_budget(self, amount: float | None) -> None:
        if self.goal is not None:
            self.goal.budget_usd = amount

    def completed_ids(self) -> set[str]:
        return {t.id for t in self.goal.tasks if t.status == "completed"} if self.goal else set()

    def record_turn_cost(
        self, actual_usd: float, est_usd: float, newly_completed_ids: list[str] | None = None
    ) -> None:
        if self.active and self.goal is not None:
            self.goal.record_turn_cost(actual_usd, est_usd, newly_completed_ids)

    def set_tasks(self, items: list[dict[str, Any]]) -> None:
        """Replace the task list (the model's `tasks set` op)."""
        if self.goal is None:
            self.goal = Goal(title="")
        self.goal.tasks = [
            GoalTask.make(
                str(it.get("content", "")).strip(),
                str(it.get("active_form", "")).strip(),
                str(it.get("status", "pending")),
            )
            for it in items
            if str(it.get("content", "")).strip()
        ]

    def update_task(self, task_id: str, status: str) -> bool:
        """Set one task's status; enforces the single-in_progress invariant. Returns matched."""
        if self.goal is None or status not in _STATUSES:
            return False
        match = next((t for t in self.goal.tasks if t.id == task_id), None)
        if match is None:
            return False
        if status == "in_progress":  # demote any other in_progress task
            for t in self.goal.tasks:
                if t.status == "in_progress":
                    t.status = "pending"
        match.status = status
        return True

    # ---- persistence ----
    def save(self, session: Any) -> None:
        if self.goal is None:
            return
        try:
            from minima_harness.session.format import EntryType

            session.append(EntryType.GOAL, self.goal.to_dict())
        except Exception:  # noqa: BLE001 - goal persistence must never break a turn
            pass

    def load(self, session: Any) -> None:
        try:
            from minima_harness.session.format import EntryType

            latest = None
            for entry in getattr(session, "entries", []):
                if entry.type == EntryType.GOAL:
                    latest = entry
            if latest is not None:
                self.goal = Goal.from_dict(latest.payload)
        except Exception:  # noqa: BLE001
            pass

    # ---- prompt rendering ----
    def prompt_block(self) -> str:
        """The goal + open tasks, injected into the system prompt each turn to re-anchor."""
        if not self.active or self.goal is None:
            return ""
        lines = [f"# Current goal: {self.goal.title}".rstrip()]
        if self.goal.tasks:
            lines.append("Task list (keep it current via the `tasks` tool; one in_progress):")
            mark = {"completed": "[x]", "in_progress": "[~]", "blocked": "[!]", "pending": "[ ]"}
            for t in self.goal.tasks:
                lines.append(f"  {mark.get(t.status, '[ ]')} {t.content}")
        return "\n".join(lines)
