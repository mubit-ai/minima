"""Agent tools and execution hooks — port of PI's ``AgentTool`` + before/afterToolCall.

Tools declare parameters as a pydantic model (the TypeBox analogue); ``execute`` is an
async callable ``(tool_call_id, params, signal, on_update) -> ToolResult``. Validation
errors and thrown exceptions become tool-error results fed back to the model so it can
retry (matching PI).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

from minima_harness.ai.types import ContentBlock, TextContent, ToolCall

if TYPE_CHECKING:
    from minima_harness.agent.state import AgentState

ToolExecutionMode = Literal["parallel", "sequential"]
ThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh"]

# on_update(partial_result) -> None; called mid-execution for streaming progress.
ToolUpdate = Callable[[Any], None]
ToolExecute = Callable[[str, BaseModel, object | None, ToolUpdate | None], Awaitable["ToolResult"]]


@dataclass(slots=True)
class ToolResult:
    """What a tool returns. ``content`` goes to the model; ``details`` are app-facing."""

    content: list[ContentBlock]
    details: dict[str, Any] = field(default_factory=dict)
    # Hint to skip the automatic follow-up LLM call. Only honoured when every finalized
    # tool result in the batch also sets terminate=True.
    terminate: bool = False


@dataclass(slots=True)
class AgentTool:
    name: str
    description: str
    parameters: type[BaseModel]
    execute: ToolExecute
    execution_mode: ToolExecutionMode | None = None
    label: str = ""


# ---------------------------------------------------------------------------
# Hook types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class BeforeToolCallContext:
    tool_call: ToolCall
    args: BaseModel  # validated params
    context: AgentState


@dataclass(slots=True)
class BeforeToolCallResult:
    block: bool = False
    reason: str = ""


@dataclass(slots=True)
class AfterToolCallContext:
    tool_call: ToolCall
    result: ToolResult
    is_error: bool
    context: AgentState


@dataclass(slots=True)
class AfterToolCallResult:
    terminate: bool = False
    details: dict[str, Any] | None = None
    content: list[ContentBlock] | None = None


BeforeToolCall = Callable[[BeforeToolCallContext], Awaitable[BeforeToolCallResult | None]]
AfterToolCall = Callable[[AfterToolCallContext], Awaitable[AfterToolCallResult | None]]


def find_agent_tool(tools: list[AgentTool], name: str) -> AgentTool | None:
    for t in tools:
        if t.name == name:
            return t
    return None


def error_result(message: str) -> ToolResult:
    """A standard error tool result (single text block)."""
    return ToolResult(content=[TextContent(text=message)])
