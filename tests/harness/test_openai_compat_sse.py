"""Hermetic test of the OpenAI-compatible provider's SSE parser via an injected
httpx.MockTransport client — no network, no API key."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.providers import ensure_providers_registered, registered_apis
from minima_harness.ai.types import Model, ModelCost

SSE = b"\n".join(
    s.encode()
    for s in [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}',
        "",
        "data: [DONE]",
        "",
    ]
)


def _sse_with_tools() -> bytes:
    head = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {"name": "echo", "arguments": '{"x":'},
                            }
                        ]
                    }
                }
            ]
        }
    )
    tail = json.dumps(
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "9}"}}]}}]}
    )
    finish = json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    usage = json.dumps({"usage": {"prompt_tokens": 3, "completion_tokens": 8}})
    return b"\n".join(
        s.encode()
        for s in [
            f"data: {head}",
            "",
            f"data: {tail}",
            "",
            f"data: {finish}",
            "",
            f"data: {usage}",
            "",
            "data: [DONE]",
            "",
        ]
    )


def _model() -> Model:
    return Model(
        id="gpt-4o-mini",
        provider="openai",
        api="openai-completions",
        name="gpt4o-mini",
        cost=ModelCost(input=0.15, output=0.60),
        context_window=128_000,
        max_tokens=1024,
    )


def _client(body: bytes) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_text_completion_via_mock_transport():
    ensure_providers_registered()
    assert "openai-completions" in registered_apis()

    async def run() -> None:
        msg = await complete(
            _model(),
            Context(messages=[Message(role="user", content="hi")]),
            options={"httpx_client": _client(SSE), "api_key": "sk-test"},
        )
        assert msg.text == "Hello world"
        assert msg.stop_reason == "stop"
        assert msg.usage.input == 5
        assert msg.usage.output == 2
        # cost from registry prices: 5*0.15/1e6 + 2*0.60/1e6
        assert msg.usage.cost.total == pytest.approx(5 * 0.15 / 1e6 + 2 * 0.60 / 1e6)

    asyncio.run(run())


def test_tool_call_completion_via_mock_transport():
    async def run() -> None:
        msg = await complete(
            _model(),
            Context(messages=[Message(role="user", content="run echo")]),
            options={"httpx_client": _client(_sse_with_tools()), "api_key": "sk-test"},
        )
        assert msg.stop_reason == "toolUse"
        assert len(msg.tool_calls) == 1
        tc = msg.tool_calls[0]
        assert tc.id == "call_1"
        assert tc.name == "echo"
        assert tc.arguments == {"x": 9}

    asyncio.run(run())


def test_provider_surfaces_http_error_as_error_event():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, content=b'{"error":"bad key"}')

    async def run() -> None:
        msg = await complete(
            _model(),
            Context(messages=[Message(role="user", content="hi")]),
            options={"httpx_client": httpx.AsyncClient(transport=httpx.MockTransport(handler))},
        )
        assert msg.stop_reason == "error"
        assert msg.error_message is not None

    asyncio.run(run())
