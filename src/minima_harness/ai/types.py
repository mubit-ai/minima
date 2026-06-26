"""Core LLM types — a lean Python port of the ``@earendil-works/pi-ai`` data model.

Wire-contract discriminator values (``type`` / ``role`` / ``stopReason``) intentionally
match PI's so anyone familiar with the TS library recognizes the shapes. Field names
are snake-cased to stay pythonic; serialization is therefore *not* byte-compatible with
the TS library, which is fine — this port is consumed in-process, not over the wire.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Cost / usage
# ---------------------------------------------------------------------------


class Cost(BaseModel):
    """USD cost breakdown for a single generation.

    ``input``/``output`` are the uncached token costs; ``cache_read``/``cache_write`` are
    the prompt-cache components (read ~0.1x input, write ~1.25x input on Anthropic).
    ``total`` is the true realized spend across all four — this is what flows to Minima's
    ``actual_cost_usd`` so the observed cost tier reflects real post-cache economics.
    """

    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    cache_write: float = 0.0
    total: float = 0.0


class Usage(BaseModel):
    """Token accounting; mirrors PI's ``AssistantMessage.usage``."""

    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cost: Cost = Field(default_factory=Cost)


# ---------------------------------------------------------------------------
# Modalities & model descriptor
# ---------------------------------------------------------------------------


class Modality(StrEnum):
    text = "text"
    image = "image"


# API ids match PI's registry so provider dispatch is recognizable.
ApiId = Literal[
    "anthropic-messages",
    "google-generative-ai",
    "openai-completions",
    "faux",
]


@dataclass(slots=True)
class ModelCost:
    """Per-million-token USD prices."""

    input: float
    output: float
    cache_read: float = 0.0
    cache_write: float = 0.0


@dataclass(slots=True)
class Model:
    """A callable model. Custom/OpenAI-compatible endpoints set ``base_url``."""

    id: str
    provider: str
    api: ApiId
    name: str
    cost: ModelCost
    context_window: int
    max_tokens: int
    input: tuple[Modality, ...] = (Modality.text,)
    reasoning: bool = False
    base_url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Content blocks
# ---------------------------------------------------------------------------


class TextContent(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageContent(BaseModel):
    type: Literal["image"] = "image"
    data: str  # base64-encoded
    mime_type: str = "image/png"


class ThinkingContent(BaseModel):
    type: Literal["thinking"] = "thinking"
    thinking: str
    # Anthropic signs every thinking block; the signature MUST be echoed back verbatim when the
    # block is replayed in history (incl. within a tool-use turn), or the API 400s with
    # "thinking.signature: Field required". Empty for providers that don't sign (e.g. Gemini).
    signature: str = ""


class ToolCall(BaseModel):
    type: Literal["toolCall"] = "toolCall"
    id: str
    name: str
    # May be partial during streaming; defaults to ``{}``, never None (matches PI).
    arguments: dict[str, Any] = Field(default_factory=dict)


ContentBlock = Annotated[
    TextContent | ImageContent | ThinkingContent | ToolCall,
    Field(discriminator="type"),
]

# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

Role = Literal["user", "assistant", "toolResult"]
StopReason = Literal["stop", "length", "toolUse", "error", "aborted"]


class Message(BaseModel):
    """A conversation message. ``content`` may be a bare string for convenience."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    role: Role
    content: list[ContentBlock]
    timestamp: int | None = None
    # toolResult-only fields:
    tool_call_id: str | None = None
    tool_name: str | None = None
    is_error: bool = False

    @field_validator("content", mode="before")
    @classmethod
    def _coerce_content(cls, value: object) -> object:
        if isinstance(value, str):
            return [TextContent(text=value)]
        return value

    @property
    def text(self) -> str:
        """Concatenated text across all TextContent blocks (empty for non-text)."""
        return "".join(b.text for b in self.content if isinstance(b, TextContent))


class AssistantMessage(Message):
    """An assistant turn. Carries usage, stop reason, and optional error info."""

    role: Literal["assistant"] = "assistant"
    model: str = ""
    stop_reason: StopReason = "stop"
    usage: Usage = Field(default_factory=Usage)
    error_message: str | None = None
    response_id: str | None = None

    @property
    def tool_calls(self) -> list[ToolCall]:
        if isinstance(self.content, str):
            return []
        return [b for b in self.content if isinstance(b, ToolCall)]


# ---------------------------------------------------------------------------
# Tools (declared here to avoid an import cycle — logic lives in tools.py)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class Tool:
    """A callable tool. ``parameters`` is a pydantic model class (the TypeBox analogue)."""

    name: str
    description: str
    parameters: type[BaseModel]


class Context(BaseModel):
    """A serializable conversation context (system prompt + messages + tools)."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    system_prompt: str | None = None
    messages: list[Message] = Field(default_factory=list)
    tools: list[Tool] = Field(default_factory=list)
