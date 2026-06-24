"""Google Generative AI (Gemini) provider via ``google-genai``.

Reuses minima's optional ``reasoner-gemini`` / ``harness`` extra. Iterates
``generate_content_stream`` chunks, mapping incremental text/thought/function-call parts
onto PI's event taxonomy. Gemini does not stream function-call arguments incrementally,
so a full ``toolcall_end`` is emitted when a ``function_call`` part arrives (matches PI's
documented behaviour).
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
    from minima_harness.ai.events import Event
    from minima_harness.ai.types import Context, Model

_FINISH_MAP = {"STOP": "stop", "MAX_TOKENS": "length", "SAFETY": "stop"}


class GoogleProvider:
    api_id = "google-generative-ai"

    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    def _build_client(self, options: dict[str, Any]) -> Any:
        if self._client is not None:
            return self._client
        import google.genai as genai  # lazy; optional extra

        api_key = resolve_api_key(
            options, "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"
        )
        timeout = int(float(options.get("timeout", 60.0)) * 1000)
        return genai.Client(api_key=api_key, http_options={"timeout": timeout})

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
        config = _build_config(model, context, options)

        text_buf: list[str] = []
        think_buf: list[str] = []
        tool_calls: list[ToolCall] = []
        seen_text = seen_think = False
        in_tokens = out_tokens = thought_tokens = cache_read = 0
        stop_reason = "stop"

        assistant = AssistantMessage(content=[], model=model.id, stop_reason="stop")
        yield StartEvent(partial=assistant)
        try:
            contents = _to_contents(context)
            stream = await client.aio.models.generate_content_stream(
                model=model.id, contents=contents, config=config
            )
            async for chunk in stream:
                usage = getattr(chunk, "usage_metadata", None)
                if usage is not None:
                    in_tokens = getattr(usage, "prompt_token_count", 0) or 0
                    out_tokens = getattr(usage, "candidates_token_count", 0) or 0
                    thought_tokens = getattr(usage, "thoughts_token_count", 0) or 0
                    cache_read = getattr(usage, "cached_content_token_count", 0) or 0
                for cand in getattr(chunk, "candidates", None) or []:
                    fr = getattr(cand, "finish_reason", None)
                    if fr:
                        stop_reason = _FINISH_MAP.get(str(fr), "stop")
                    content = getattr(cand, "content", None)
                    for part in getattr(content, "parts", None) or []:
                        if getattr(part, "thought", False):
                            txt = getattr(part, "text", "") or ""
                            if txt:
                                if not seen_think:
                                    seen_think = True
                                    yield ThinkingStartEvent(content_index=0)
                                think_buf.append(txt)
                                yield ThinkingDeltaEvent(delta=txt, content_index=0)
                        elif getattr(part, "function_call", None):
                            fc = part.function_call
                            name = getattr(fc, "name", "") or ""
                            args = dict(getattr(fc, "args", None) or {})
                            call = ToolCall(id=f"call_{len(tool_calls)}", name=name, arguments=args)
                            tool_calls.append(call)
                            idx = len(tool_calls) - 1
                            yield ToolCallStartEvent(content_index=idx)
                            yield ToolCallEndEvent(tool_call=call, content_index=idx)
                        else:
                            txt = getattr(part, "text", None)
                            if txt:
                                if not seen_text:
                                    seen_text = True
                                    yield TextStartEvent(content_index=0)
                                text_buf.append(txt)
                                yield TextDeltaEvent(delta=txt, content_index=0)
        except Exception as exc:  # noqa: BLE001
            err = AssistantMessage(
                content=[TextContent(text="")], stop_reason="error", error_message=str(exc)
            )
            err.model = model.id
            yield ErrorEvent(reason="error", error=err)
            return

        # Assemble content in canonical order: thinking, text, tool calls.
        blocks: list[Any] = []
        if seen_think:
            thinking = "".join(think_buf)
            blocks.append(ThinkingContent(thinking=thinking))
            yield ThinkingEndEvent(content=thinking, content_index=0)
        if seen_text:
            text = "".join(text_buf)
            blocks.append(TextContent(text=text))
            yield TextEndEvent(content=text, content_index=0)
        blocks.extend(tool_calls)
        if not blocks:
            blocks.append(TextContent(text=""))

        if tool_calls:
            stop_reason = "toolUse"
        assistant.content = blocks
        assistant.stop_reason = stop_reason  # type: ignore[assignment]
        assistant.usage.input = in_tokens
        assistant.usage.output = out_tokens + thought_tokens
        assistant.usage.cache_read = cache_read
        attach_cost(model, assistant.usage)
        yield DoneEvent(reason=assistant.stop_reason, message=assistant)


def _build_config(model: Model, context: Context, options: dict[str, Any]) -> dict[str, Any]:
    config: dict[str, Any] = {"max_output_tokens": options.get("max_tokens", model.max_tokens)}
    if context.system_prompt:
        config["system_instruction"] = context.system_prompt
    if context.tools:
        config["tools"] = [
            {
                "function_declarations": [
                    {
                        "name": t.name,
                        "description": t.description,
                        "parameters": to_json_schema(t.parameters),
                    }
                    for t in context.tools
                ]
            }
        ]
    if options.get("thinking") and model.reasoning:
        config["thinking_config"] = {"include_thoughts": True}
    return config


def _to_contents(context: Context) -> list[dict[str, Any]]:
    """Build google-genai ``contents`` (role user/model + parts) from the context."""
    messages = normalize_for_target(context.messages, "google-generative-ai")
    out: list[dict[str, Any]] = []
    for m in messages:
        role = "model" if m.role == "assistant" else "user"
        parts: list[dict[str, Any]] = []
        if m.role == "toolResult":
            parts.append(
                {
                    "function_response": {
                        "name": m.tool_name or "",
                        "response": {"result": _flatten_text(m)},
                    }
                }
            )
        else:
            blocks = m.content if not isinstance(m.content, str) else [TextContent(text=m.content)]
            for b in blocks:
                if isinstance(b, TextContent):
                    parts.append({"text": b.text})
                elif isinstance(b, ImageContent):
                    parts.append({"inline_data": {"mime_type": b.mime_type, "data": b.data}})
                elif isinstance(b, ToolCall):
                    parts.append({"function_call": {"name": b.name, "args": b.arguments or {}}})
        out.append({"role": role, "parts": parts})
    return out


def _flatten_text(m: Message) -> str:
    if isinstance(m.content, str):
        return m.content
    return "".join(b.text for b in m.content if isinstance(b, TextContent))
