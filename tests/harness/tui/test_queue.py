from __future__ import annotations

import pytest

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.widgets.editor import Editor


def _app(streaming: bool) -> HarnessApp:
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    agent.state.is_streaming = streaming
    return HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)


@pytest.mark.asyncio
async def test_enter_while_streaming_steers():
    app = _app(streaming=True)
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.text = "actually use python"
        ed.focus()
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()
    assert len(app.agent.state.steering) == 1
    assert "python" in app.agent.state.steering[0].text


@pytest.mark.asyncio
async def test_alt_enter_queues_followup():
    app = _app(streaming=True)
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.text = "then add tests"
        ed.focus()
        await pilot.pause()
        await pilot.press("alt+enter")
        await pilot.pause()
    assert len(app.agent.state.follow_up) == 1
    assert "tests" in app.agent.state.follow_up[0].text


@pytest.mark.asyncio
async def test_enter_while_idle_submits_normally():
    # When idle, Enter must NOT steer — it should clear the editor (ready for a turn).
    app = _app(streaming=False)
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.text = "a normal prompt"
        ed.focus()
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()
        assert ed.text == ""
        assert len(app.agent.state.steering) == 0
