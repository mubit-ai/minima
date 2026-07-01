from __future__ import annotations

import json
import sys

from minima_harness.agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    TurnEndEvent,
)
from minima_harness.ai.events import ErrorEvent, TextDeltaEvent
from minima_harness.lsp.manager import shutdown_all as _lsp_shutdown
from minima_harness.minima.runtime import MinimaAgent


def event_to_dict(event) -> dict:  # noqa: ANN001
    """Serialize an AgentEvent into a JSON-friendly dict (PI-style JSON mode)."""
    if isinstance(event, MessageUpdateEvent):
        stream = event.assistant_message_event
        if isinstance(stream, TextDeltaEvent):
            return {"type": "text_delta", "delta": stream.delta}
        if isinstance(stream, ErrorEvent):
            err = stream.error
            return {
                "type": "error",
                "message": getattr(err, "error_message", "") or "provider error",
                "model": getattr(err, "model", ""),
            }
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
    """One-shot: run the prompt, print the final assistant text, exit.

    A provider failure (bad key, 404, network) produces empty output; report the classified
    reason on stderr and exit non-zero instead of silently printing a blank line.
    """
    try:
        await agent.prompt(prompt)
        err = getattr(agent, "_last_error", None)
        last = agent._last_assistant()  # noqa: SLF001
        text = last.text if last is not None else ""
        if err and not text.strip():
            print(err, file=sys.stderr)
            return 1
        print(text)
        return 0
    finally:
        # Reap any warm LSP servers spawned this run (no-op unless the lsp tool was used).
        await _lsp_shutdown()


async def run_json(agent: MinimaAgent, prompt: str) -> int:
    """Stream every AgentEvent as a JSON line, then exit."""
    agent.subscribe(lambda event: print(json.dumps(event_to_dict(event)), flush=True))
    try:
        await agent.prompt(prompt)
        return 0
    finally:
        await _lsp_shutdown()
