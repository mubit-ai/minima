"""Anthropic Messages API provider (wraps the ``anthropic`` SDK, async).

Reuses minima's optional ``reasoner-anthropic`` / ``harness`` extra. Maps the SDK's raw
stream events onto PI's event taxonomy and assembles the final AssistantMessage with
realized token usage (input from ``message_start``, output from ``message_delta``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from minima_harness.ai.compat import normalize_for_target
from minima_harness.ai.events import (
    DoneEvent,
    ErrorEvent,
    StartEvent,
    TextDeltaEvent,
    TextEndEvent,
    TextStartEvent,
    ThinkingDeltaEvent,
    ThinkingEndEvent,
    ThinkingStartEvent,
    ToolCall,
    ToolCallDeltaEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from minima_harness.ai.providers._common import resolve_api_key, to_json_schema
from minima_harness.ai.types import (
    AssistantMessage,
    ImageContent,
    Message,
    TextContent,
    ThinkingContent,
)
from minima_harness.ai.usage import attach_cost

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic

    from minima_harness.ai.events import Event
    from minima_harness.ai.types import Context, Model

_STOP_MAP = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "toolUse",
}


class AnthropicProvider:
    api_id = "anthropic-messages"

    def __init__(self, client: AsyncAnthropic | None = None) -> None:
        self._client = client

    def _build_client(self, options: dict[str, Any]) -> AsyncAnthropic:
        if self._client is not None:
            return self._client
        from anthropic import AsyncAnthropic

        api_key = resolve_api_key(options, "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN")
        return AsyncAnthropic(api_key=api_key, timeout=options.get("timeout", 60.0))

    async def stream(
        self,
        model: Model,
        context: Context,
        *,
        options: dict[str, Any] | None = None,
        signal: object | None = None,
    ) -> AsyncIterator[Event]:
        options = options or {}
        client = self._build_client(options)
        kwargs = _build_kwargs(model, context, options)
        assistant = AssistantMessage(content=[], model=model.id, stop_reason="stop")
        text_buf: dict[int, list[str]] = {}
        think_buf: dict[int, list[str]] = {}
        tools_acc: dict[int, dict[str, str]] = {}
        in_tokens = out_tokens = cache_read = cache_write = 0

        yield StartEvent(partial=assistant)
        try:
            async with client.messages.stream(**kwargs) as s:
                async for ev in s:
                    etype = getattr(ev, "type", "")

                    if etype == "message_start":
                        usage = getattr(getattr(ev, "message", None), "usage", None)
                        if usage is not None:
                            in_tokens = getattr(usage, "input_tokens", 0) or 0
                            cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
                            cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0

                    elif etype == "content_block_start":
                        idx = getattr(ev, "index", 0)
                        block = getattr(ev, "content_block", None)
                        btype = getattr(block, "type", "")
                        if btype == "text":
                            yield TextStartEvent(content_index=idx)
                        elif btype == "thinking":
                            yield ThinkingStartEvent(content_index=idx)
                        elif btype == "tool_use":
                            tools_acc[idx] = {
                                "id": getattr(block, "id", "") or f"call_{idx}",
                                "name": getattr(block, "name", ""),
                                "args": "",
                            }
                            yield ToolCallStartEvent(content_index=idx)

                    elif etype == "content_block_delta":
                        idx = getattr(ev, "index", 0)
                        delta = getattr(ev, "delta", None)
                        dtype = getattr(delta, "type", "")
                        if dtype == "text_delta":
                            txt = getattr(delta, "text", "") or ""
                            text_buf.setdefault(idx, []).append(txt)
                            yield TextDeltaEvent(delta=txt, content_index=idx)
                        elif dtype == "thinking_delta":
                            txt = getattr(delta, "thinking", "") or ""
                            think_buf.setdefault(idx, []).append(txt)
                            yield ThinkingDeltaEvent(delta=txt, content_index=idx)
                        elif dtype == "input_json_delta":
                            partial = getattr(delta, "partial_json", "") or ""
                            if idx in tools_acc:
                                tools_acc[idx]["args"] += partial
                            yield ToolCallDeltaEvent(delta=partial, content_index=idx)

                    elif etype == "content_block_stop":
                        idx = getattr(ev, "index", 0)
                        if idx in tools_acc:
                            slot = tools_acc[idx]
                            import json

                            try:
                                args = json.loads(slot["args"]) if slot["args"].strip() else {}
                            except json.JSONDecodeError:
                                args = {"_raw": slot["args"]}
                            call = ToolCall(id=slot["id"], name=slot["name"], arguments=args)
                            assistant.content.append(call)
                            yield ToolCallEndEvent(tool_call=call, content_index=idx)
                        elif idx in think_buf:
                            thinking = "".join(think_buf[idx])
                            assistant.content.append(ThinkingContent(thinking=thinking))
                            yield ThinkingEndEvent(content=thinking, content_index=idx)
                        elif idx in text_buf:
                            text = "".join(text_buf[idx])
                            assistant.content.append(TextContent(text=text))
                            yield TextEndEvent(content=text, content_index=idx)

                    elif etype == "message_delta":
                        delta = getattr(ev, "delta", None)
                        stop = getattr(delta, "stop_reason", None)
                        if stop:
                            assistant.stop_reason = _STOP_MAP.get(stop, "stop")  # type: ignore[assignment]
                        usage = getattr(ev, "usage", None)
                        if usage is not None:
                            out_tokens = getattr(usage, "output_tokens", 0) or 0
        except Exception as exc:  # noqa: BLE001
            err = AssistantMessage(
                content=[TextContent(text="")], stop_reason="error", error_message=str(exc)
            )
            err.model = model.id
            yield ErrorEvent(reason="error", error=err)
            return

        if not assistant.content:
            assistant.content.append(TextContent(text=""))
        assistant.usage.input = in_tokens
        assistant.usage.output = out_tokens
        assistant.usage.cache_read = cache_read
        assistant.usage.cache_write = cache_write
        attach_cost(model, assistant.usage)
        yield DoneEvent(reason=assistant.stop_reason, message=assistant)


_EPHEMERAL = {"type": "ephemeral"}


def _build_kwargs(model: Model, context: Context, options: dict[str, Any]) -> dict[str, Any]:
    # Prompt caching is ON by default (the agent re-sends a large stable prefix —
    # system prompt + tool schemas + conversation history — every turn). cache_control
    # breakpoints mark the longest prefix to cache: Anthropic reads it at ~0.1x next turn.
    # Callers with unique one-shot prompts (e.g. the LLM judge) pass prompt_cache=False to
    # avoid a pointless cache write. Below the per-model min-cacheable size the API simply
    # ignores the breakpoint, so this is always safe.
    cache = bool(options.get("prompt_cache", True))
    messages = normalize_for_target(context.messages, "anthropic-messages")
    wire = [_to_wire(m) for m in messages]
    kwargs: dict[str, Any] = {
        "model": model.id,
        "max_tokens": options.get("max_tokens", model.max_tokens),
        "messages": wire,
    }
    if context.system_prompt:
        if cache:
            kwargs["system"] = [
                {"type": "text", "text": context.system_prompt, "cache_control": _EPHEMERAL}
            ]
        else:
            kwargs["system"] = context.system_prompt
    if context.tools:
        tools = [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": to_json_schema(t.parameters),
            }
            for t in context.tools
        ]
        if cache and tools:
            # A breakpoint on the LAST tool caches the whole (stable) tool array.
            tools[-1] = {**tools[-1], "cache_control": _EPHEMERAL}
        kwargs["tools"] = tools
    if cache and wire:
        _mark_last_block(wire[-1])
    # Thinking is opt-in via options to avoid surprise token spend.
    if options.get("thinking") and model.reasoning:
        budget = options.get("thinking_budget", 1024)
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": int(budget)}
    return kwargs


def _mark_last_block(wire_msg: dict[str, Any]) -> None:
    """Add a cache_control breakpoint to the last content block of a wire message.

    Caches the conversation prefix incrementally: each turn extends the cached prefix, so
    the prior history is re-read at ~0.1x rather than re-charged at the full input rate.
    """
    content = wire_msg.get("content")
    if isinstance(content, list) and content and isinstance(content[-1], dict):
        content[-1] = {**content[-1], "cache_control": _EPHEMERAL}


def _to_wire(m: Message) -> dict[str, Any]:
    if m.role == "toolResult":
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id,
                    "content": _flatten_text(m),
                    "is_error": m.is_error,
                }
            ],
        }
    blocks = m.content if not isinstance(m.content, str) else [TextContent(text=m.content)]
    content: list[dict[str, Any]] = []
    for b in blocks:
        if isinstance(b, TextContent):
            content.append({"type": "text", "text": b.text})
        elif isinstance(b, ImageContent):
            content.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": b.mime_type, "data": b.data},
                }
            )
        elif isinstance(b, ThinkingContent):
            content.append({"type": "thinking", "thinking": b.thinking})
        elif isinstance(b, ToolCall):
            content.append(
                {"type": "tool_use", "id": b.id, "name": b.name, "input": b.arguments or {}}
            )
    return {"role": m.role, "content": content}


def _flatten_text(m: Message) -> str:
    if isinstance(m.content, str):
        return m.content
    return "".join(b.text for b in m.content if isinstance(b, TextContent))
