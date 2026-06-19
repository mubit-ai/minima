from __future__ import annotations

from minima_harness.agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    TurnEndEvent,
    TurnStartEvent,
)
from minima_harness.ai.events import TextDeltaEvent
from minima_harness.tui.bridge import EventBridge


async def test_bridge_accumulates_streaming_text():
    br = EventBridge()
    await br(MessageStartEvent())
    await br(MessageUpdateEvent(assistant_message_event=TextDeltaEvent(delta="Hello ")))
    await br(MessageUpdateEvent(assistant_message_event=TextDeltaEvent(delta="world.")))
    await br(MessageEndEvent())
    assert br.assistant_text == "Hello world."


async def test_bridge_records_tool_calls_and_turns():
    br = EventBridge()
    await br(AgentStartEvent())
    await br(TurnStartEvent())
    await br(ToolExecutionStartEvent(tool_call_id="t1", tool_name="bash"))
    await br(ToolExecutionEndEvent(tool_call_id="t1", is_error=False))
    await br(TurnEndEvent())
    await br(AgentEndEvent())
    assert [t["name"] for t in br.tools] == ["bash"]
    assert br.turns == 1
    assert br.finished is True


async def test_bridge_ignores_non_text_deltas():
    from minima_harness.ai.events import ThinkingDeltaEvent

    br = EventBridge()
    await br(MessageUpdateEvent(assistant_message_event=ThinkingDeltaEvent(delta="internal")))
    assert br.assistant_text == ""


async def test_bridge_invokes_bound_text_callback():
    seen: list[str] = []
    br = EventBridge()
    br.bind(on_text=lambda d: seen.append(d))
    await br(MessageUpdateEvent(assistant_message_event=TextDeltaEvent(delta="abc")))
    assert seen == ["abc"]
