"""/thoughts toggle (stream the model's reasoning) and /exit command."""

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
async def test_thoughts_toggle_and_enables_thinking():
    app = _app()
    async with app.run_test() as pilot:
        assert app._show_thinking is False
        app.agent.state.thinking_level = "off"
        await app._dispatch_command("thoughts", "on")
        await pilot.pause()
        assert app._show_thinking is True
        # turning thoughts on with thinking off bumps the level so there's something to show
        assert app.agent.state.thinking_level == "medium"
        await app._dispatch_command("thoughts", "off")
        await pilot.pause()
        assert app._show_thinking is False


@pytest.mark.asyncio
async def test_thinking_bubble_streams_then_drops_when_empty():
    from minima_harness.tui.widgets.messages import ChatLog, MessageBubble

    app = _app()
    async with app.run_test() as pilot:
        chatlog = app.query_one(ChatLog)
        app._show_thinking = True
        app._thinking_bubble = await chatlog.add_thinking_stream()
        app._on_thinking("reason ")
        app._on_thinking("about it")
        assert app._thinking_bubble.buffer == "reason about it"
        await app._finalize_thinking()  # non-empty -> kept
        assert app._thinking_bubble is None
        # an empty thinking bubble is removed
        empty = await chatlog.add_thinking_stream()
        app._thinking_bubble = empty
        await app._finalize_thinking()
        await pilot.pause()
        assert app._thinking_bubble is None
        assert empty not in app.query(MessageBubble)


@pytest.mark.asyncio
async def test_exit_command_quits():
    app = _app()
    called: list = []
    async with app.run_test() as pilot:
        app.exit = lambda *a, **k: called.append(True)  # type: ignore[method-assign]
        await app._dispatch_command("exit", "")
        await app._dispatch_command("quit", "")
        await pilot.pause()
    assert called == [True, True]  # both /exit and /quit quit the app
