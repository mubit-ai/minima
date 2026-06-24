"""Streaming event types emitted during assistant message generation.

A faithful port of PI's event taxonomy. Events are immutable dataclasses so they can
be safely fanned out to multiple subscribers. ``content_index`` associates each delta
or end event with its block (providers interleave deltas across text/thinking/tools).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from minima_harness.ai.types import AssistantMessage, StopReason, ToolCall

StreamEventReason = Literal["error", "aborted"]


@dataclass(frozen=True, slots=True)
class StartEvent:
    """Stream begins. ``partial`` is the initial assistant message skeleton."""

    type: Literal["start"] = "start"
    partial: AssistantMessage | None = None


@dataclass(frozen=True, slots=True)
class TextStartEvent:
    type: Literal["text_start"] = "text_start"
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class TextDeltaEvent:
    type: Literal["text_delta"] = "text_delta"
    delta: str = ""
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class TextEndEvent:
    type: Literal["text_end"] = "text_end"
    content: str = ""
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ThinkingStartEvent:
    type: Literal["thinking_start"] = "thinking_start"
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ThinkingDeltaEvent:
    type: Literal["thinking_delta"] = "thinking_delta"
    delta: str = ""
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ThinkingEndEvent:
    type: Literal["thinking_end"] = "thinking_end"
    content: str = ""
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ToolCallStartEvent:
    type: Literal["toolcall_start"] = "toolcall_start"
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ToolCallDeltaEvent:
    """Partial tool arguments (best-effort parse; fields may be missing)."""

    type: Literal["toolcall_delta"] = "toolcall_delta"
    delta: str = ""
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class ToolCallEndEvent:
    type: Literal["toolcall_end"] = "toolcall_end"
    tool_call: ToolCall = None  # type: ignore[assignment]  # set by provider
    content_index: int = 0


@dataclass(frozen=True, slots=True)
class DoneEvent:
    type: Literal["done"] = "done"
    reason: StopReason = "stop"
    message: AssistantMessage = None  # type: ignore[assignment]  # set by provider


@dataclass(frozen=True, slots=True)
class ErrorEvent:
    """Emitted on provider error or abort. ``error`` carries partial content."""

    type: Literal["error"] = "error"
    reason: StreamEventReason = "error"
    error: AssistantMessage = None  # type: ignore[assignment]  # set by provider


Event = (
    StartEvent
    | TextStartEvent
    | TextDeltaEvent
    | TextEndEvent
    | ThinkingStartEvent
    | ThinkingDeltaEvent
    | ThinkingEndEvent
    | ToolCallStartEvent
    | ToolCallDeltaEvent
    | ToolCallEndEvent
    | DoneEvent
    | ErrorEvent
)
