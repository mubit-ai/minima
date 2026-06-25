"""Goal model, GoalStore (mutation + invariants + persistence), and the tasks tool."""

from __future__ import annotations

import asyncio

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


def test_tasks_tool_update_requires_fields():
    store = GoalStore()
    store.start("g")
    store.set_tasks([{"content": "x"}])
    tool = tasks_tool(store)
    res = asyncio.run(tool.execute("id", TasksParams(op="update"), None, lambda _p: None))
    assert "needs task_id and status" in res.content[0].text
