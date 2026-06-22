from __future__ import annotations

import pytest

from minima_harness.ai.types import Message
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.widgets.editor import Editor


def _app() -> HarnessApp:
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    return HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)


@pytest.mark.asyncio
async def test_compact_too_few_messages_is_a_noop():
    app = _app()
    async with app.run_test() as pilot:
        await app._dispatch_command("compact", "")
        await pilot.pause()
    assert app.agent.state.messages == []


@pytest.mark.asyncio
async def test_compact_summarizes_old_messages(monkeypatch):
    app = _app()
    app.agent.state.messages = [Message(role="user", content=f"msg {i}") for i in range(6)]

    seen: list[int] = []

    async def fake_summarize(msgs, model, *, instructions=""):  # noqa: ANN001
        seen.append(len(msgs))
        return "SUMMARY"

    monkeypatch.setattr("minima_harness.tui.app.summarize", fake_summarize)
    async with app.run_test() as pilot:
        await app._dispatch_command("compact", "")
        await pilot.pause()

    assert seen == [4]  # keep = max(2, 6//4)=2 → old = 4 summarized, 2 kept
    assert len(app.agent.state.messages) == 3  # summary note + 2 recent
    assert "SUMMARY" in app.agent.state.messages[0].text


@pytest.mark.asyncio
async def test_shift_tab_cycles_thinking_level():
    app = _app()
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.focus()
        assert app.agent.state.thinking_level == "off"
        await pilot.press("shift+tab")
        await pilot.pause()
        assert app.agent.state.thinking_level == "low"
        await pilot.press("shift+tab")
        await pilot.pause()
        assert app.agent.state.thinking_level == "medium"
