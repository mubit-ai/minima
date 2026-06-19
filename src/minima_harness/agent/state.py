"""Agent run state and loop config.

``AgentState`` is both the observable state (read via ``agent.state``) and the mutable
context threaded through :func:`agent_loop` — it carries messages, tools, and the
steering/follow-up queues the Agent pushes into. Loop config is split out so it can be
rebuilt per run (the Agent holds the knobs; the loop receives a frozen snapshot).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from minima_harness.agent.tools import (
    AfterToolCall,
    BeforeToolCall,
    ThinkingLevel,
    ToolExecutionMode,
)
from minima_harness.ai.types import AssistantMessage, Message, Model


@dataclass(slots=True)
class AgentState:
    """Mutable run state shared between the Agent and the loop."""

    system_prompt: str | None = None
    model: Model | None = None
    thinking_level: ThinkingLevel = "off"
    tools: list = field(default_factory=list)  # list[AgentTool]
    messages: list[Message] = field(default_factory=list)
    # Streaming flags (observable).
    is_streaming: bool = False
    streaming_message: AssistantMessage | None = None
    pending_tool_calls: set[str] = field(default_factory=set)
    error_message: str | None = None
    # Queues the Agent pushes into mid-run; drained between turns by the loop.
    steering: deque[Message] = field(default_factory=deque)
    follow_up: deque[Message] = field(default_factory=deque)
    steering_mode: str = "one-at-a-time"
    follow_up_mode: str = "one-at-a-time"


# (messages) -> messages to send to the LLM (filter custom types, prune, etc.)
ConvertToLlm = Callable[[list[Message]], list[Message]]
# (messages, signal) -> messages (optional compaction/injection before convert_to_llm)
TransformContext = Callable[[list[Message], object | None], Awaitable[list[Message]]]
# Run after a turn settles; return True to stop gracefully (e.g. before compaction).
ShouldStopAfterTurn = Callable[[AssistantMessage, list, AgentState, list[Message]], Awaitable[bool]]
StreamFn = Callable[..., Any]


@dataclass(frozen=True, slots=True)
class AgentLoopConfig:
    """Snapshot of loop behaviour handed to :func:`agent_loop`."""

    model: Model
    convert_to_llm: ConvertToLlm
    tool_execution: ToolExecutionMode = "parallel"
    before_tool_call: BeforeToolCall | None = None
    after_tool_call: AfterToolCall | None = None
    transform_context: TransformContext | None = None
    should_stop_after_turn: ShouldStopAfterTurn | None = None
    thinking_budgets: dict[str, int] | None = None
    thinking_level: ThinkingLevel = "off"
    max_turns: int = 50
    session_id: str | None = None
    stream_fn: StreamFn | None = None
    stream_options: dict[str, Any] | None = None


def default_convert_to_llm(messages: list[Message]) -> list[Message]:
    """Drop anything the LLM can't ingest (keeps user/assistant/toolResult)."""
    return [m for m in messages if m.role in ("user", "assistant", "toolResult")]
