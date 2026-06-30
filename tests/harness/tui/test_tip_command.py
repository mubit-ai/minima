from __future__ import annotations

import pytest

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.widgets.messages import ChatLog, MessageBubble


def _make_app(tmp_path) -> HarnessApp:
    cfg = HarnessConfig(allow_offline=True)
    return HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )


@pytest.mark.asyncio
async def test_tip_command_prints_a_tip(tmp_path):
    app = _make_app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        await app._dispatch_command("tip", "")
        await pilot.pause()
        bubbles = app.query_one(ChatLog).query(MessageBubble)
        assert any("💡" in b.buffer for b in bubbles)


@pytest.mark.asyncio
async def test_tip_off_disables_spinner_tips(tmp_path):
    app = _make_app(tmp_path)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app._tips_enabled is True
        await app._dispatch_command("tip", "off")
        await pilot.pause()
        assert app._tips_enabled is False
        await app._dispatch_command("tip", "on")
        await pilot.pause()
        assert app._tips_enabled is True


@pytest.mark.asyncio
async def test_tip_registered_and_listed(tmp_path):
    app = _make_app(tmp_path)
    assert app.commands.get("tip") is not None
    assert any(c.name == "tip" for c in app.commands.all())  # not hidden
