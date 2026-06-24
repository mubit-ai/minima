"""Cross-provider message compatibility.

Assistant messages produced by one provider (e.g. Anthropic thinking blocks) cannot
always be replayed verbatim into another provider's request. The transform here mirrors
PI's rule: thinking blocks become ``<thinking>...</thinking>`` tagged text when the
target api differs from the source; text, tool calls and tool results pass through.

Each provider still owns its *to-wire* mapping (anthropic ``tool_use`` blocks vs google
``function_call`` parts vs openai ``tool_calls``). This module only normalizes the
provider-agnostic :class:`~minima_harness.ai.types.Message` list beforehand.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from minima_harness.ai.types import Message, TextContent

if TYPE_CHECKING:
    from collections.abc import Iterable

    from minima_harness.ai.types import AssistantMessage

_THINK_OPEN = "<thinking>"
_THINK_CLOSE = "</thinking>"


def thinking_to_text(message: AssistantMessage) -> AssistantMessage:
    """Return a copy with every ThinkingContent block folded into tagged text.

    Thinking blocks are replaced in place by a TextContent wrapping the thinking in
    ``<thinking>`` tags; adjacent ordering is preserved so the conversation still reads
    naturally to a foreign model.
    """
    new_content: list = []
    if isinstance(message.content, str):  # pragma: no cover - coerced upstream
        return message
    for block in message.content:
        if hasattr(block, "thinking"):
            new_content.append(TextContent(text=f"{_THINK_OPEN}{block.thinking}{_THINK_CLOSE}"))
        else:
            new_content.append(block)
    new = message.model_copy(update={"content": new_content})
    return new


def source_api_of(message: AssistantMessage) -> str | None:
    """Infer the api that produced ``message`` from its ``model`` id (registry lookup)."""
    if not message.model:
        return None
    from minima_harness.ai.registry import find_model_by_id

    model = find_model_by_id(message.model)
    return model.api if model is not None else None


def normalize_for_target(messages: Iterable[Message], target_api: str) -> list[Message]:
    """Cross-provider normalize a message list before to-wire mapping for ``target_api``.

    Assistant messages whose source api differs from ``target_api`` have their thinking
    blocks converted to tagged text; everything else is returned unchanged.
    """
    out: list[Message] = []
    for m in messages:
        if m.role == "assistant":
            asst = cast("AssistantMessage", m)
            source = source_api_of(asst)
            if source is not None and source != target_api:
                m = thinking_to_text(asst)
        out.append(m)
    return out
