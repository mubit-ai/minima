from __future__ import annotations

import json

from minima_harness.agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    TurnEndEvent,
)
from minima_harness.ai.events import TextDeltaEvent
from minima_harness.minima.runtime import MinimaAgent


def event_to_dict(event) -> dict:  # noqa: ANN001
    """Serialize an AgentEvent into a JSON-friendly dict (PI-style JSON mode)."""
    if isinstance(event, MessageUpdateEvent):
        stream = event.assistant_message_event
        if isinstance(stream, TextDeltaEvent):
            return {"type": "text_delta", "delta": stream.delta}
        return {"type": "message_update"}
    if isinstance(event, ToolExecutionStartEvent):
        return {"type": "tool_start", "name": event.tool_name}
    if isinstance(event, ToolExecutionEndEvent):
        return {"type": "tool_end", "is_error": event.is_error}
    if isinstance(event, TurnEndEvent):
        return {"type": "turn_end"}
    if isinstance(event, AgentEndEvent):
        return {"type": "done"}
    if isinstance(event, AgentStartEvent):
        return {"type": "start"}
    return {"type": getattr(event, "type", "unknown")}


async def run_print(agent: MinimaAgent, prompt: str) -> int:
    """One-shot: run the prompt, print the final assistant text, exit."""
    await agent.prompt(prompt)
    last = agent._last_assistant()  # noqa: SLF001
    print(last.text if last is not None else "")
    return 0


async def run_json(agent: MinimaAgent, prompt: str) -> int:
    """Stream every AgentEvent as a JSON line, then exit."""
    agent.subscribe(lambda event: print(json.dumps(event_to_dict(event)), flush=True))
    await agent.prompt(prompt)
    return 0
