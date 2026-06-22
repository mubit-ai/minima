from __future__ import annotations

import pytest

from minima_harness.tui import clipboard


def test_copy_to_clipboard_darwin_pbcopy(monkeypatch):
    monkeypatch.setattr(clipboard.sys, "platform", "darwin")
    captured: dict = {}

    def fake_run(cmd, input=None, check=False, **k):  # noqa: ANN001
        captured["cmd"] = cmd
        captured["input"] = input
        return 0

    monkeypatch.setattr(clipboard.subprocess, "run", fake_run)
    assert clipboard.copy_to_clipboard("hi") is True
    assert captured["cmd"] == ["pbcopy"]
    assert captured["input"] == b"hi"


def test_copy_to_clipboard_no_tool_returns_false(monkeypatch):
    monkeypatch.setattr(clipboard.sys, "platform", "unknown-os")
    monkeypatch.setattr(clipboard.shutil, "which", lambda _: None)
    assert clipboard.copy_to_clipboard("hi") is False


@pytest.mark.asyncio
async def test_copy_command_copies_last_reply(monkeypatch):
    from minima_harness.ai.types import AssistantMessage, TextContent
    from minima_harness.minima.config import HarnessConfig
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    agent.state.messages = [
        AssistantMessage(role="assistant", content=[TextContent(text="the reply")])
    ]
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    seen: dict = {}
    monkeypatch.setattr(
        "minima_harness.tui.app.copy_to_clipboard",
        lambda t: (seen.__setitem__("t", t), True)[1],
    )
    async with app.run_test() as pilot:
        await app._dispatch_command("copy", "")
        await pilot.pause()
    assert seen.get("t") == "the reply"


@pytest.mark.asyncio
async def test_copy_command_with_args_copies_literal(monkeypatch):
    from minima_harness.minima.config import HarnessConfig
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]))
    seen: dict = {}
    monkeypatch.setattr(
        "minima_harness.tui.app.copy_to_clipboard",
        lambda t: (seen.__setitem__("t", t), True)[1],
    )
    async with app.run_test() as pilot:
        await app._dispatch_command("copy", "literal text")
        await pilot.pause()
    assert seen.get("t") == "literal text"
