"""OpenAI-compatible Chat Completions provider (raw httpx, no ``openai`` SDK).

One implementation covers openai, openrouter, groq, xai, together, and any server
speaking the ``POST {base_url}/chat/completions`` SSE protocol — selected by
``Model.base_url``. Matches PI's fetch-based approach and keeps dependencies lean.

Streaming deltas carry: ``choices[0].delta.content`` (text), ``.tool_calls`` (function
calls, assembled from partial JSON), and ``.reasoning_content`` / ``.reasoning`` (thinking
for deepseek/openrouter-style models). The final chunk carries ``usage`` when
``stream_options.include_usage`` is honoured.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx

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
    ToolCall,
)
from minima_harness.ai.usage import attach_cost

if TYPE_CHECKING:
    from minima_harness.ai.events import Event
    from minima_harness.ai.types import Context, Model

_DEFAULT_BASE = "https://api.openai.com/v1"
_FINISH_MAP = {
    "stop": "stop",
    "length": "length",
    "tool_calls": "toolUse",
    "function_call": "toolUse",
}


class OpenAICompatProvider:
    api_id = "openai-completions"

    async def stream(
        self,
        model: Model,
        context: Context,
        *,
        options: dict[str, Any] | None = None,
        signal: object | None = None,
    ) -> AsyncIterator[Event]:
        options = options or {}
        api_key = resolve_api_key(
            options, "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_COMPAT_API_KEY"
        )
        base = (model.base_url or _DEFAULT_BASE).rstrip("/")
        url = f"{base}/chat/completions"
        payload = _build_payload(model, context, options)
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers.update(model.headers)

        timeout = options.get("timeout", 60.0)
        try:
            client = options.get("httpx_client") or httpx.AsyncClient(timeout=timeout)
            req = client.build_request("POST", url, json=payload, headers=headers)
            resp = await client.send(req, stream=True)
            try:
                resp.raise_for_status()
                async for ev in _consume_sse(resp, model):
                    yield ev
            finally:
                await resp.aclose()
                if not options.get("httpx_client"):
                    await client.aclose()
        except Exception as exc:  # noqa: BLE001 - surface as an error event, not a raise
            err = AssistantMessage(
                content=[TextContent(text="")], stop_reason="error", error_message=str(exc)
            )
            err.model = model.id
            yield ErrorEvent(reason="error", error=err)


def _build_payload(model: Model, context: Context, options: dict[str, Any]) -> dict[str, Any]:
    messages = normalize_for_target(context.messages, "openai-completions")
    out: list[dict[str, Any]] = []
    if context.system_prompt:
        out.append({"role": "system", "content": context.system_prompt})
    out.extend(_to_wire(m) for m in messages)
    payload: dict[str, Any] = {
        "model": model.id,
        "messages": out,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": options.get("max_tokens", model.max_tokens),
    }
    if context.tools:
        payload["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": to_json_schema(t.parameters),
                },
            }
            for t in context.tools
        ]
    return payload


def _to_wire(m: Message) -> dict[str, Any]:
    if m.role == "toolResult":
        return {
            "role": "tool",
            "tool_call_id": m.tool_call_id,
            "content": _flatten_text(m),
        }
    blocks = m.content if not isinstance(m.content, str) else [TextContent(text=m.content)]
    tool_calls = [b for b in blocks if isinstance(b, ToolCall)]
    entry: dict[str, Any] = {"role": m.role}
    text = "".join(b.text for b in blocks if isinstance(b, TextContent))
    images = [b for b in blocks if isinstance(b, ImageContent)]
    parts: list[dict[str, Any]] = []
    if text:
        parts.append({"type": "text", "text": text})
    for img in images:
        parts.append(
            {"type": "image_url", "image_url": {"url": f"data:{img.mime_type};base64,{img.data}"}}
        )
    if parts:
        entry["content"] = parts if images else text
    else:
        entry["content"] = text
    if tool_calls:
        entry["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
            }
            for tc in tool_calls
        ]
    return entry


def _flatten_text(m: Message) -> str:
    if isinstance(m.content, str):
        return m.content
    return "".join(b.text for b in m.content if isinstance(b, TextContent))


async def _consume_sse(resp: httpx.Response, model: Model) -> AsyncIterator[Event]:
    text_buf: dict[int, list[str]] = {}
    think_buf: dict[int, list[str]] = {}
    # tool index -> {id, name, args_parts}
    tools: dict[int, dict[str, str]] = {}
    seen_text = seen_think = False
    finish_reason = "stop"
    usage_input = usage_output = 0
    assistant = AssistantMessage(content=[], model=model.id, stop_reason="stop")
    yield StartEvent(partial=assistant)

    async for line in resp.aiter_lines():
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if chunk.get("usage"):
            usage_input = chunk["usage"].get("prompt_tokens", usage_input)
            usage_output = chunk["usage"].get("completion_tokens", usage_output)
        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}
        fr = choice.get("finish_reason")
        if fr:
            finish_reason = _FINISH_MAP.get(fr, "stop")

        if "reasoning_content" in delta and delta["reasoning_content"]:
            idx = 0
            think_buf.setdefault(idx, []).append(delta["reasoning_content"])
            if not seen_think:
                seen_think = True
                yield ThinkingStartEvent(content_index=idx)
            yield ThinkingDeltaEvent(delta=delta["reasoning_content"], content_index=idx)
        if delta.get("reasoning"):
            idx = 0
            think_buf.setdefault(idx, []).append(delta["reasoning"])
            if not seen_think:
                seen_think = True
                yield ThinkingStartEvent(content_index=idx)
            yield ThinkingDeltaEvent(delta=delta["reasoning"], content_index=idx)

        content = delta.get("content")
        if content:
            idx = 0
            text_buf.setdefault(idx, []).append(content)
            if not seen_text:
                seen_text = True
                yield TextStartEvent(content_index=idx)
            yield TextDeltaEvent(delta=content, content_index=idx)

        for tc in delta.get("tool_calls") or []:
            idx = tc.get("index", 0)
            slot = tools.setdefault(idx, {"id": "", "name": "", "args": ""})
            fn = tc.get("function") or {}
            if tc.get("id") and not slot["id"]:
                slot["id"] = tc["id"]
            if fn.get("name") and not slot["name"]:
                slot["name"] = fn["name"]
            if fn.get("arguments"):
                slot["args"] += fn["arguments"]
                yield ToolCallDeltaEvent(delta=fn["arguments"], content_index=idx)

    # finalize blocks in stable index order: thinking(0) -> text(0) -> tools
    if seen_think:
        idx = 0
        thinking = "".join(think_buf.get(idx, []))
        assistant.content.append(ThinkingContent(thinking=thinking))
        yield ThinkingEndEvent(content=thinking, content_index=idx)
    if seen_text:
        idx = 0
        text = "".join(text_buf.get(idx, []))
        assistant.content.append(TextContent(text=text))
        yield TextEndEvent(content=text, content_index=idx)
    for idx in sorted(tools):
        slot = tools[idx]
        raw_args = slot["args"] or "{}"
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            args = {"_raw": raw_args}
        call = ToolCall(id=slot["id"] or f"call_{idx}", name=slot["name"], arguments=args)
        assistant.content.append(call)
        yield ToolCallStartEvent(content_index=idx)
        yield ToolCallEndEvent(tool_call=call, content_index=idx)

    assistant.stop_reason = finish_reason  # type: ignore[assignment]
    if not assistant.content:
        assistant.content.append(TextContent(text=""))
    assistant.usage.input = usage_input
    assistant.usage.output = usage_output
    attach_cost(model, assistant.usage)
    yield DoneEvent(reason=assistant.stop_reason, message=assistant)
