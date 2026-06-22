from __future__ import annotations

import pytest

from minima_harness.ai.types import AssistantMessage, Message, TextContent
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp, _conversation_to_markdown


def test_conversation_to_markdown_preserves_markdown_source():
    msgs = [
        Message(role="user", content="**show me** code"),
        AssistantMessage(role="assistant", content=[TextContent(text="# Title\n\n**bold** reply")]),
    ]
    md = _conversation_to_markdown(msgs)
    assert "## You" in md and "**show me** code" in md
    assert "## Assistant" in md and "# Title" in md and "**bold** reply" in md


@pytest.mark.asyncio
async def test_export_command_writes_markdown_file(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    agent.state.messages = [
        Message(role="user", content="hi there"),
        AssistantMessage(role="assistant", content=[TextContent(text="hello **world**")]),
    ]
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent, cwd=tmp_path)
    out = tmp_path / "conv.md"
    async with app.run_test() as pilot:
        await app._dispatch_command("export", str(out))
        await pilot.pause()
    text = out.read_text(encoding="utf-8")
    assert "## You" in text and "hi there" in text
    assert "## Assistant" in text and "hello **world**" in text
