from __future__ import annotations

import pytest

from minima_harness.tui.widgets.messages import ChatLog, MessageBubble


def test_message_bubble_append_accumulates():
    b = MessageBubble("assistant")
    b.append("Hello ")
    b.append("world.")
    b.flush()
    assert b.buffer == "Hello world."


def test_message_bubble_throttle_does_not_lose_data():
    b = MessageBubble("assistant")
    for ch in "streaming":
        b.append(ch)  # may skip flushes due to throttle, but buffer keeps everything
    b.flush()
    assert b.buffer == "streaming"


def test_message_bubble_set_text_replaces():
    b = MessageBubble("user", "old")
    b.set_text("new")
    assert b.buffer == "new"


@pytest.mark.asyncio
async def test_chatlog_mounts_bubbles_and_streams():
    from textual.app import App, ComposeResult

    class _App(App):
        def compose(self) -> ComposeResult:
            yield ChatLog()

    app = _App()
    async with app.run_test() as pilot:
        chat = app.query_one(ChatLog)
        await chat.add_user("hi")
        bubble = await chat.add_assistant_stream()
        bubble.append("answer")
        bubble.flush()
        await pilot.pause()
        bubbles = chat.query(MessageBubble)
        assert len(bubbles) == 2
        assert bubbles[0].buffer == "hi"
        assert bubbles[1].buffer == "answer"
