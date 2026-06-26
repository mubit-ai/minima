"""Hermetic test of the Anthropic provider's event mapping via an injected fake client.

No API key, no network. The fake mimics the SDK's raw stream events enough for the
provider's getattr-based dispatch.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from pydantic import BaseModel

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.providers import ensure_providers_registered, get_provider, register_provider
from minima_harness.ai.providers.anthropic import AnthropicProvider
from minima_harness.ai.types import Model, ModelCost, Tool, Usage
from minima_harness.ai.usage import cost_for


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


class _EchoArgs(BaseModel):
    x: int


def _run_with_context(ctx: Context, *, options: dict[str, Any] | None = None) -> dict[str, Any]:
    """Drive complete() through a fake client and return the wire kwargs it saw."""
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    fake = _FakeClient(_events())
    register_provider("anthropic-messages", AnthropicProvider(client=fake))
    try:
        asyncio.run(complete(_model(), ctx, options=options))
    finally:
        register_provider("anthropic-messages", original)
    return fake.last_kwargs


def test_prompt_caching_marks_stable_prefix_by_default():
    ctx = Context(
        system_prompt="you are a coding agent",
        messages=[Message(role="user", content="hi")],
        tools=[Tool(name="echo", description="echo", parameters=_EchoArgs)],
    )
    kw = _run_with_context(ctx)
    # system becomes a list of blocks with a cache breakpoint
    assert isinstance(kw["system"], list)
    assert kw["system"][-1]["cache_control"] == {"type": "ephemeral"}
    # the last tool carries a breakpoint (caches the whole tool array)
    assert kw["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    # the last message's last content block carries a breakpoint (incremental history cache)
    assert kw["messages"][-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}


def test_prompt_caching_can_be_disabled():
    ctx = Context(
        system_prompt="you are a coding agent",
        messages=[Message(role="user", content="hi")],
        tools=[Tool(name="echo", description="echo", parameters=_EchoArgs)],
    )
    kw = _run_with_context(ctx, options={"prompt_cache": False})
    assert kw["system"] == "you are a coding agent"  # plain string, no breakpoint
    assert "cache_control" not in kw["tools"][-1]
    assert "cache_control" not in kw["messages"][-1]["content"][-1]


def _run_events(events: list[Any]):
    """Drive complete() with a custom event stream; return the assembled assistant message."""
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    fake = _FakeClient(events)
    register_provider("anthropic-messages", AnthropicProvider(client=fake))
    try:
        return asyncio.run(
            complete(_model(), Context(messages=[Message(role="user", content="hi")]))
        )
    finally:
        register_provider("anthropic-messages", original)


def test_stream_captures_thinking_signature():
    # Anthropic streams the thinking block's cryptographic signature as a signature_delta; the
    # provider must capture it onto ThinkingContent (or the block can't be replayed later).
    from minima_harness.ai.types import ThinkingContent

    ev = [
        SimpleNamespace(
            type="message_start",
            message=SimpleNamespace(
                usage=SimpleNamespace(
                    input_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0
                )
            ),
        ),
        SimpleNamespace(
            type="content_block_start", index=0, content_block=SimpleNamespace(type="thinking")
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="thinking_delta", thinking="let me think"),
        ),
        SimpleNamespace(
            type="content_block_delta",
            index=0,
            delta=SimpleNamespace(type="signature_delta", signature="sig-xyz"),
        ),
        SimpleNamespace(type="content_block_stop", index=0),
        SimpleNamespace(type="message_delta", delta=SimpleNamespace(stop_reason="end_turn")),
        SimpleNamespace(type="message_stop"),
    ]
    msg = _run_events(ev)
    thinks = [b for b in msg.content if isinstance(b, ThinkingContent)]
    assert thinks and thinks[0].thinking == "let me think"
    assert thinks[0].signature == "sig-xyz"


def test_signed_thinking_block_is_replayed_with_signature():
    # A prior assistant thinking block must be sent back WITH its signature, or Anthropic 400s
    # ("thinking.signature: Field required").
    from minima_harness.ai.types import AssistantMessage, TextContent, ThinkingContent

    ctx = Context(
        messages=[
            Message(role="user", content="hi"),
            AssistantMessage(
                role="assistant",
                model="claude-haiku-4-5",
                content=[
                    ThinkingContent(thinking="ponder", signature="abc123"),
                    TextContent(text="the answer"),
                ],
            ),
            Message(role="user", content="continue"),
        ]
    )
    kw = _run_with_context(ctx, options={"prompt_cache": False})
    asst = next(m for m in kw["messages"] if m["role"] == "assistant")
    think = [b for b in asst["content"] if b.get("type") == "thinking"]
    assert think and think[0]["thinking"] == "ponder" and think[0]["signature"] == "abc123"


def test_unsigned_thinking_block_is_dropped_not_sent_unsigned():
    # An unsigned thinking block (e.g. from another provider, or an older session) is dropped
    # rather than sent without a signature — sending it unsigned is the exact 400 we're fixing.
    from minima_harness.ai.types import AssistantMessage, TextContent, ThinkingContent

    ctx = Context(
        messages=[
            Message(role="user", content="hi"),
            AssistantMessage(
                role="assistant",
                model="claude-haiku-4-5",
                content=[
                    ThinkingContent(thinking="ponder", signature=""),  # unsigned
                    TextContent(text="the answer"),
                ],
            ),
            Message(role="user", content="continue"),
        ]
    )
    kw = _run_with_context(ctx, options={"prompt_cache": False})
    asst = next(m for m in kw["messages"] if m["role"] == "assistant")
    types = [b.get("type") for b in asst["content"]]
    assert "thinking" not in types  # dropped — never sent unsigned
    assert "text" in types  # the rest of the turn survives


def test_cost_for_includes_cache_components():
    model = Model(
        id="claude-haiku-4-5",
        provider="anthropic",
        api="anthropic-messages",
        name="haiku",
        cost=ModelCost(input=1.0, output=5.0, cache_read=0.1, cache_write=1.25),
        context_window=200_000,
        max_tokens=1024,
    )
    usage = Usage(input=1_000_000, output=0, cache_read=1_000_000, cache_write=1_000_000)
    cost = cost_for(model, usage)
    assert cost.input == 1.0
    assert cost.cache_read == 0.1
    assert cost.cache_write == 1.25
    # total folds in the cache components (was previously undercounted)
    assert cost.total == 1.0 + 0.1 + 1.25
