"""/goals command flow: set → footer progress + prompt anchor → overlay → clear."""

from __future__ import annotations

import pytest

from minima_harness.ai import get_model
from minima_harness.ai.providers import ensure_providers_registered
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp


def _app() -> HarnessApp:
    ensure_providers_registered()
    from minima_harness.minima.meter import CostMeter

    model = get_model("anthropic", "claude-haiku-4-5")
    cfg = HarnessConfig(minima_url="", candidates=["claude-haiku-4-5"], allow_offline=True)
    agent = MinimaAgent(cfg, model=model, meter=CostMeter())
    return HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)


@pytest.mark.asyncio
async def test_goals_set_clear_and_footer():
    app = _app()
    async with app.run_test() as pilot:
        assert app._goal_footer() == ""  # no goal initially
        await app._dispatch_command("ledger", "set Ship the OAuth flow")
        await pilot.pause()
        assert app._goals.active is True
        assert app._goals.goal.title == "Ship the OAuth flow"
        # goal is anchored into the system prompt
        assert "Ship the OAuth flow" in app.agent.state.system_prompt
        # model lays out tasks via the tasks tool
        app._goals.set_tasks([{"content": "a", "status": "completed"}, {"content": "b"}])
        assert app._goal_footer() == "1/2"
        # clear
        await app._dispatch_command("ledger", "clear")
        await pilot.pause()
        assert app._goals.active is False
        assert app._goal_footer() == ""
        assert "Ship the OAuth flow" not in app.agent.state.system_prompt


@pytest.mark.asyncio
async def test_goals_is_hidden_alias_of_ledger():
    app = _app()
    async with app.run_test() as pilot:
        # /goals still works (hidden alias)...
        await app._dispatch_command("goals", "set Legacy name")
        await pilot.pause()
        assert app._goals.goal.title == "Legacy name"
        # ...but it's not advertised in the palette/help (only /ledger is).
        listed = {c.name for c in app.commands.all()}
        assert "ledger" in listed and "goals" not in listed


@pytest.mark.asyncio
async def test_goals_tool_is_registered_on_agent():
    app = _app()
    async with app.run_test():
        names = {t.name for t in app.agent.state.tools}
    assert "tasks" in names  # the model can maintain the checklist


@pytest.mark.asyncio
async def test_goals_overlay_opens():
    from minima_harness.tui.overlays import GoalsOverlay

    app = _app()
    async with app.run_test() as pilot:
        app._goals.start("Demo goal")
        app._goals.set_tasks([{"content": "task one"}])
        await app._dispatch_command("ledger", "")  # no args -> overlay
        await pilot.pause()
        assert isinstance(app.screen, GoalsOverlay)
        assert app.screen.query_one("#goals-card").border_title == "ledger"
        await pilot.press("escape")
        await pilot.pause()


@pytest.mark.asyncio
async def test_active_goal_conditions_routing():
    app = _app()
    captured: dict = {}

    async def spy(text, *, task_type=None, slider=None, files=None, tags=None):  # noqa: ANN001
        captured["task_type"] = task_type
        captured["tags"] = tags
        return None  # routing offline -> harmless for this test

    async with app.run_test() as pilot:
        app.agent.prompt = spy  # type: ignore[method-assign]
        app._goals.start("Build OAuth")
        app._goals.goal.task_type = "code"
        await app.run_turn("do the thing")
        await pilot.pause()

    assert captured["task_type"] == "code"
    assert any(t.startswith("goal:") for t in (captured["tags"] or []))


@pytest.mark.asyncio
async def test_emit_goal_cost_line_attributes_and_renders():
    from types import SimpleNamespace

    from minima_harness.minima.meter import CostRow
    from minima_harness.tui.widgets.messages import ChatLog, MessageBubble

    app = _app()
    async with app.run_test() as pilot:
        app._goals.start("g")
        app._goals.set_tasks([{"content": "step", "status": "in_progress"}, {"content": "next"}])
        app.agent.meter.rows.append(
            CostRow(
                label="t", model="m", decision_basis="memory",
                est_cost_usd=0.008, actual_cost_usd=0.012, baseline_cost_usd=None,
                quality=None, outcome="success",
            )
        )
        await app._emit_goal_cost_line(SimpleNamespace())  # routing truthy
        await pilot.pause()
        texts = " ".join(b.buffer for b in app.query_one(ChatLog).query(MessageBubble))

    assert app._goals.goal.spent_usd() == pytest.approx(0.012)  # attributed to the in_progress task
    assert "ledger ·" in texts and "spent $0.0120" in texts


@pytest.mark.asyncio
async def test_goal_cost_distributes_across_batched_completions():
    # The E2E case: model plans + completes several tasks in one turn with no in_progress step.
    from types import SimpleNamespace

    from minima_harness.minima.meter import CostRow

    app = _app()
    async with app.run_test() as pilot:
        app._goals.start("g")
        app._goals.set_tasks([{"content": "a"}, {"content": "b"}])
        app._goal_completed_before = app._goals.completed_ids()  # none completed before the turn
        for t in app._goals.goal.tasks:  # model marks both done at once
            t.status = "completed"
        app.agent.meter.rows.append(
            CostRow(
                label="t", model="m", decision_basis="memory",
                est_cost_usd=0.01, actual_cost_usd=0.02, baseline_cost_usd=None,
                quality=None, outcome="success",
            )
        )
        await app._emit_goal_cost_line(SimpleNamespace())
        await pilot.pause()

    costs = [t.actual_cost_usd for t in app._goals.goal.tasks]
    assert all(c == pytest.approx(0.01) for c in costs)  # $0.02 split across the 2 completed
    assert app._goals.goal.spent_extra_usd == 0.0  # nothing fell through to goal-level


@pytest.mark.asyncio
async def test_goal_budget_command():
    app = _app()
    async with app.run_test() as pilot:
        app._goals.start("g")
        await app._dispatch_command("ledger", "budget 2.50")
        await pilot.pause()
        assert app._goals.goal.budget_usd == pytest.approx(2.50)


@pytest.mark.asyncio
async def test_goal_survives_session_reload():
    app = _app()
    async with app.run_test() as pilot:
        await app._dispatch_command("ledger", "set Persisted goal")
        app._goals.set_tasks([{"content": "x"}])
        app._goals.save(app.session)
        await pilot.pause()
        # simulate reopening the same session
        from minima_harness.minima.goals import GoalStore

        fresh = GoalStore()
        fresh.load(app.session)
    assert fresh.goal is not None and fresh.goal.title == "Persisted goal"
