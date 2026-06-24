"""Agent runtime events — a port of PI's ``pi-agent-core`` event taxonomy.

Emitted by :func:`minima_harness.agent.loop.agent_loop` in a strict order per turn::

    agent_start
      (per turn)
        turn_start
        message_start  {user or toolResult}
        message_end    {...}
        message_start  {assistant}
        message_update {assistant_message_event: a provider StreamEvent}
        message_end    {assistant}
        tool_execution_start / tool_execution_update / tool_execution_end  (if toolUse)
        message_start  {toolResult} / message_end
        turn_end
    agent_end

Events are immutable dataclasses so they can be fanned out to many subscribers safely.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from minima_harness.ai.events import Event as StreamEvent

if TYPE_CHECKING:
    pass


@dataclass(frozen=True, slots=True)
class AgentStartEvent:
    type: Literal["agent_start"] = "agent_start"


@dataclass(frozen=True, slots=True)
class AgentEndEvent:
    type: Literal["agent_end"] = "agent_end"
    messages: list = field(default_factory=list)  # list[Message]


@dataclass(frozen=True, slots=True)
class TurnStartEvent:
    type: Literal["turn_start"] = "turn_start"


@dataclass(frozen=True, slots=True)
class TurnEndEvent:
    type: Literal["turn_end"] = "turn_end"
    message: Any = None  # AssistantMessage | None
    tool_results: list = field(default_factory=list)  # list[ToolResult]


@dataclass(frozen=True, slots=True)
class MessageStartEvent:
    type: Literal["message_start"] = "message_start"
    message: Any = None  # Message | None


@dataclass(frozen=True, slots=True)
class MessageUpdateEvent:
    """Assistant-only. Wraps a provider streaming event (text/thinking/toolcall delta)."""

    type: Literal["message_update"] = "message_update"
    assistant_message_event: StreamEvent | None = None


@dataclass(frozen=True, slots=True)
class MessageEndEvent:
    type: Literal["message_end"] = "message_end"
    message: Any = None  # Message | None


@dataclass(frozen=True, slots=True)
class ToolExecutionStartEvent:
    type: Literal["tool_execution_start"] = "tool_execution_start"
    tool_call_id: str = ""
    tool_name: str = ""
    args: Any = None  # validated params (pydantic model) | None when blocked/invalid


@dataclass(frozen=True, slots=True)
class ToolExecutionUpdateEvent:
    type: Literal["tool_execution_update"] = "tool_execution_update"
    tool_call_id: str = ""
    partial: Any = None


@dataclass(frozen=True, slots=True)
class ToolExecutionEndEvent:
    type: Literal["tool_execution_end"] = "tool_execution_end"
    tool_call_id: str = ""
    result: Any = None  # ToolResult | None
    is_error: bool = False


AgentEvent = (
    AgentStartEvent
    | AgentEndEvent
    | TurnStartEvent
    | TurnEndEvent
    | MessageStartEvent
    | MessageUpdateEvent
    | MessageEndEvent
    | ToolExecutionStartEvent
    | ToolExecutionUpdateEvent
    | ToolExecutionEndEvent
)


__all__ = [
    "AgentEndEvent",
    "AgentEvent",
    "AgentStartEvent",
    "MessageEndEvent",
    "MessageStartEvent",
    "MessageUpdateEvent",
    "ToolExecutionEndEvent",
    "ToolExecutionStartEvent",
    "ToolExecutionUpdateEvent",
    "TurnEndEvent",
    "TurnStartEvent",
]
