"""The ``tasks`` tool — the agent's live goal checklist (like Claude Code's TodoWrite).

Bound to the session's :class:`~minima_harness.minima.goals.GoalStore` via :func:`tasks_tool`.
The model calls it to lay out a plan (``set``) and tick items off (``update``) as it works. The
harness re-injects the list into the system prompt each turn so it stays the "north star".
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent
from minima_harness.minima.goals import GoalStore

_MARK = {"completed": "[x]", "in_progress": "[~]", "blocked": "[!]", "pending": "[ ]"}


class TaskItem(BaseModel):
    content: str  # imperative: "Add OAuth login"
    active_form: str = ""  # present-continuous: "Adding OAuth login"
    status: str = "pending"  # pending | in_progress | completed | blocked


class TasksParams(BaseModel):
    op: Literal["set", "update", "list"]
    tasks: list[TaskItem] | None = None  # op=set: replace the whole list
    task_id: str | None = None  # op=update: which task
    status: str | None = None  # op=update: new status


def _render(store: GoalStore) -> str:
    goal = store.goal
    if goal is None or not goal.tasks:
        return "(no tasks)"
    done, total = goal.progress()
    head = f"{done}/{total} done" + (f" · {goal.title}" if goal.title else "")
    lines = [head] + [f"  {_MARK.get(t.status, '[ ]')} {t.id}  {t.content}" for t in goal.tasks]
    return "\n".join(lines)


def tasks_tool(store: GoalStore) -> AgentTool:
    async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
        assert isinstance(params, TasksParams)
        if params.op == "set":
            store.set_tasks([t.model_dump() for t in (params.tasks or [])])
        elif params.op == "update":
            if not params.task_id or not params.status:
                return error_result("tasks update needs task_id and status")
            if not store.update_task(params.task_id, params.status):
                return error_result(
                    f"no task {params.task_id!r} (or bad status); use op=list to see ids"
                )
        # op=list falls through to render
        done, total = store.goal.progress() if store.goal else (0, 0)
        return ToolResult(
            content=[TextContent(text=_render(store))],
            details={"completed": done, "total": total},
        )

    return AgentTool(
        name="tasks",
        description=(
            "Maintain the goal checklist. Use it for multi-step work (3+ steps); skip it for "
            "trivial or single-step requests. op='set' replaces the whole list (each task: "
            "content imperative + optional active_form); op='update' sets one task's status by "
            "task_id (pending|in_progress|completed|blocked); op='list' shows the current list. "
            "Keep exactly ONE task in_progress at a time, and mark a task completed ONLY when it "
            "is actually done and verified — never on intent."
        ),
        parameters=TasksParams,
        execute=_execute,
    )
