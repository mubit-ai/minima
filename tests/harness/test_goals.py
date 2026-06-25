"""Goal model, GoalStore (mutation + invariants + persistence), and the tasks tool."""

from __future__ import annotations

import asyncio

import pytest

from minima_harness.minima.goals import Goal, GoalStore, GoalTask
from minima_harness.session import SessionStore
from minima_harness.tools.tasks import TasksParams, tasks_tool


def test_progress_and_active():
    g = Goal(
        title="ship feature",
        tasks=[
            GoalTask.make("a", status="completed"),
            GoalTask.make("b", status="in_progress"),
            GoalTask.make("c"),
        ],
    )
    assert g.progress() == (1, 3)
    assert g.active() is not None and g.active().content == "b"


def test_serialization_round_trip():
    g = Goal(title="t", tasks=[GoalTask.make("do x")], task_type="code", budget_usd=0.5)
    g2 = Goal.from_dict(g.to_dict())
    assert g2.title == "t" and g2.task_type == "code" and g2.budget_usd == 0.5
    assert [t.content for t in g2.tasks] == ["do x"]


def test_update_enforces_single_in_progress():
    store = GoalStore()
    store.start("goal")
    store.set_tasks([{"content": "first"}, {"content": "second"}])
    ids = [t.id for t in store.goal.tasks]
    assert store.update_task(ids[0], "in_progress") is True
    assert store.update_task(ids[1], "in_progress") is True  # second becomes the only in_progress
    in_prog = [t for t in store.goal.tasks if t.status == "in_progress"]
    assert len(in_prog) == 1 and in_prog[0].id == ids[1]


def test_update_unknown_task_returns_false():
    store = GoalStore()
    store.start("g")
    store.set_tasks([{"content": "x"}])
    assert store.update_task("nope", "completed") is False


def test_prompt_block_lists_open_tasks():
    store = GoalStore()
    store.start("Build the thing")
    store.set_tasks([{"content": "step one", "status": "in_progress"}, {"content": "step two"}])
    block = store.prompt_block()
    assert "Build the thing" in block
    assert "[~] step one" in block and "[ ] step two" in block
    # no active goal -> empty block
    store.clear()
    assert store.prompt_block() == ""


def test_persists_through_session_store():
    session = SessionStore.in_memory()
    store = GoalStore()
    store.start("persisted goal")
    store.set_tasks([{"content": "alpha"}, {"content": "beta", "status": "completed"}])
    store.save(session)

    reloaded = GoalStore()
    reloaded.load(session)
    assert reloaded.goal is not None
    assert reloaded.goal.title == "persisted goal"
    assert reloaded.goal.progress() == (1, 2)


def test_tasks_tool_set_update_list():
    store = GoalStore()
    store.start("g")
    tool = tasks_tool(store)

    async def run(params):
        return await tool.execute("id", params, None, lambda _p: None)

    res = asyncio.run(run(TasksParams(op="set", tasks=[{"content": "do a"}, {"content": "do b"}])))
    assert res.details == {"completed": 0, "total": 2}
    assert "do a" in res.content[0].text

    tid = store.goal.tasks[0].id
    res = asyncio.run(run(TasksParams(op="update", task_id=tid, status="completed")))
    assert res.details == {"completed": 1, "total": 2}

    res = asyncio.run(run(TasksParams(op="update", task_id="ghost", status="completed")))
    assert "no task" in res.content[0].text  # unknown id reported to the model


def test_routing_signals_include_goal_tag():
    g = Goal(title="Ship OAuth login", task_type="code", tags=["auth"])
    task_type, tags = g.routing_signals()
    assert task_type == "code"
    assert tags[0].startswith("goal:") and "auth" in tags


def test_record_turn_cost_attributes_to_in_progress_task():
    g = Goal(title="g", tasks=[GoalTask.make("a", status="in_progress"), GoalTask.make("b")])
    g.record_turn_cost(0.01, 0.008)
    g.record_turn_cost(0.02, 0.009)
    assert g.tasks[0].actual_cost_usd == pytest.approx(0.03)
    assert g.tasks[0].est_cost_usd == pytest.approx(0.008)  # captured once, not overwritten
    assert g.spent_usd() == pytest.approx(0.03)


def test_record_turn_cost_falls_back_to_goal_when_no_active_task():
    g = Goal(title="g", tasks=[GoalTask.make("a")])  # none in_progress, none newly completed
    g.record_turn_cost(0.05, 0.04)
    assert g.spent_extra_usd == pytest.approx(0.05)
    assert g.spent_usd() == pytest.approx(0.05)


def test_record_turn_cost_distributes_across_newly_completed():
    # The batched case: model plans, does the work, marks several done — no in_progress step.
    g = Goal(title="g", tasks=[GoalTask.make("a"), GoalTask.make("b"), GoalTask.make("c")])
    g.tasks[0].status = "completed"
    g.tasks[1].status = "completed"
    g.record_turn_cost(0.03, 0.024, newly_completed_ids=[g.tasks[0].id, g.tasks[1].id])
    assert g.tasks[0].actual_cost_usd == pytest.approx(0.015)  # 0.03 split across the 2
    assert g.tasks[1].actual_cost_usd == pytest.approx(0.015)
    assert g.tasks[2].actual_cost_usd == 0.0  # untouched
    assert g.spent_extra_usd == 0.0  # nothing fell through to goal-level
    assert g.spent_usd() == pytest.approx(0.03)


def test_projected_total_extrapolates_from_progress():
    g = Goal(
        title="g",
        tasks=[GoalTask.make(f"t{i}") for i in range(5)],
    )
    assert g.projected_total_usd() is None  # nothing done yet
    g.tasks[0].status = "completed"
    g.tasks[1].status = "completed"
    g.tasks[0].actual_cost_usd = 0.02
    g.tasks[1].actual_cost_usd = 0.02  # $0.04 spent at 2/5 done
    assert g.projected_total_usd() == pytest.approx(0.04 / 2 * 5)  # ~$0.10


def test_tasks_tool_update_requires_fields():
    store = GoalStore()
    store.start("g")
    store.set_tasks([{"content": "x"}])
    tool = tasks_tool(store)
    res = asyncio.run(tool.execute("id", TasksParams(op="update"), None, lambda _p: None))
    assert "needs task_id and status" in res.content[0].text
