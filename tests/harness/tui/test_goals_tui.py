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
    model = get_model("anthropic", "claude-haiku-4-5")
    cfg = HarnessConfig(minima_url="", candidates=["claude-haiku-4-5"], allow_offline=True)
    return HarnessApp(cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, model=model))


@pytest.mark.asyncio
async def test_goals_set_clear_and_footer():
    app = _app()
    async with app.run_test() as pilot:
        assert app._goal_footer() == ""  # no goal initially
        await app._dispatch_command("goals", "set Ship the OAuth flow")
        await pilot.pause()
        assert app._goals.active is True
        assert app._goals.goal.title == "Ship the OAuth flow"
        # goal is anchored into the system prompt
        assert "Ship the OAuth flow" in app.agent.state.system_prompt
        # model lays out tasks via the tasks tool
        app._goals.set_tasks([{"content": "a", "status": "completed"}, {"content": "b"}])
        assert app._goal_footer() == "1/2"
        # clear
        await app._dispatch_command("goals", "clear")
        await pilot.pause()
        assert app._goals.active is False
        assert app._goal_footer() == ""
        assert "Ship the OAuth flow" not in app.agent.state.system_prompt


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
        await app._dispatch_command("goals", "")  # no args -> overlay
        await pilot.pause()
        assert isinstance(app.screen, GoalsOverlay)
        assert app.screen.query_one("#goals-card").border_title == "goals"
        await pilot.press("escape")
        await pilot.pause()


@pytest.mark.asyncio
async def test_goal_survives_session_reload():
    app = _app()
    async with app.run_test() as pilot:
        await app._dispatch_command("goals", "set Persisted goal")
        app._goals.set_tasks([{"content": "x"}])
        app._goals.save(app.session)
        await pilot.pause()
        # simulate reopening the same session
        from minima_harness.minima.goals import GoalStore

        fresh = GoalStore()
        fresh.load(app.session)
    assert fresh.goal is not None and fresh.goal.title == "Persisted goal"
