"""Hermetic test of the Anthropic provider's event mapping via an injected fake client.

No API key, no network. The fake mimics the SDK's raw stream events enough for the
provider's getattr-based dispatch.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.providers import ensure_providers_registered, get_provider, register_provider
from minima_harness.ai.providers.anthropic import AnthropicProvider
from minima_harness.ai.types import Model, ModelCost


def _model() -> Model:
    return Model(
        id="claude-haiku-4-5",
        provider="anthropic",
        api="anthropic-messages",
        name="haiku",
        cost=ModelCost(input=1.0, output=5.0),
        context_window=200_000,
        max_tokens=1024,
    )


class _FakeStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for e in self._events:
            yield e


class _FakeClient:
    """Minimal stand-in: ``client.messages.stream(**kw)`` -> async ctx -> async iter."""

    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.last_kwargs: dict[str, Any] = {}

        class _Messages:
            def __init__(self, outer: _FakeClient) -> None:
                self._outer = outer

            def stream(self, **kwargs: Any) -> Any:
                self._outer.last_kwargs = kwargs
                events = self._outer._events

                class _Mgr:
                    async def __aenter__(self_) -> _FakeStream:
                        return _FakeStream(events)

                    async def __aexit__(self_, *exc: object) -> None:
                        return None

                return _Mgr()

        self.messages = _Messages(self)


def _events() -> list[Any]:
    return [
        SimpleNamespace(
            type="message_start",
            message=SimpleNamespace(
                usage=SimpleNamespace(
                    input_tokens=12, cache_read_input_tokens=0, cache_creation_input_tokens=0
                )
            ),
        ),
        SimpleNamespace(
            type="content_block_start", index=0, content_block=SimpleNamespace(type="text")
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="text_delta", text="Hello "),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="text_delta", text="there"),
        ),
        SimpleNamespace(type="content_block_stop", index=0),
        SimpleNamespace(
            type="content_block_start",
            index=1,
            content_block=SimpleNamespace(type="tool_use", id="tu_1", name="echo"),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=1,
            delta=SimpleNamespace(type="input_json_delta", partial_json='{"x":'),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=1,
            delta=SimpleNamespace(type="input_json_delta", partial_json="9}"),
        ),
        SimpleNamespace(type="content_block_stop", index=1),
        SimpleNamespace(
            type="message_delta",
            delta=SimpleNamespace(stop_reason="tool_use"),
            usage=SimpleNamespace(output_tokens=8),
        ),
        SimpleNamespace(type="message_stop"),
    ]


def test_anthropic_maps_text_tool_and_usage():
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    fake = _FakeClient(_events())
    register_provider("anthropic-messages", AnthropicProvider(client=fake))
    try:

        async def run() -> None:
            msg = await complete(_model(), Context(messages=[Message(role="user", content="hi")]))
            assert msg.text == "Hello there"
            assert msg.stop_reason == "toolUse"
            assert len(msg.tool_calls) == 1
            assert msg.tool_calls[0].name == "echo"
            assert msg.tool_calls[0].arguments == {"x": 9}
            assert msg.usage.input == 12
            assert msg.usage.output == 8
            assert msg.usage.cost.total > 0.0
            assert fake.last_kwargs["model"] == "claude-haiku-4-5"
            assert fake.last_kwargs["max_tokens"] == 1024

        asyncio.run(run())
    finally:
        register_provider("anthropic-messages", original)
