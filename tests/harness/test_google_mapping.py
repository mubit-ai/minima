"""Hermetic test of the Google provider's event mapping via an injected fake client.

No API key, no network. ``client.aio.models.generate_content_stream(...)`` returns an
awaitable of an async iterable of chunks whose parts we mimic with SimpleNamespace.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.providers import ensure_providers_registered, get_provider, register_provider
from minima_harness.ai.providers.google import GoogleProvider
from minima_harness.ai.types import Model, ModelCost


def _model() -> Model:
    return Model(
        id="gemini-2.5-flash",
        provider="google",
        api="google-generative-ai",
        name="flash",
        cost=ModelCost(input=0.30, output=2.50),
        context_window=1_000_000,
        max_tokens=1024,
    )


class _FakeModels:
    def __init__(self, chunks: list[Any]) -> None:
        self._chunks = chunks
        self.last_config: dict[str, Any] = {}

    async def generate_content_stream(self, *, model: str, contents: Any, config: Any) -> Any:
        self.last_config = config or {}

        class _Stream:
            def __init__(self, items: list[Any]) -> None:
                self._items = items

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for it in self._items:
                    yield it

        return _Stream(self._chunks)


class _FakeClient:
    def __init__(self, chunks: list[Any]) -> None:
        self.models = _FakeModels(chunks)
        self.aio = SimpleNamespace(models=self.models)


def _chunks() -> list[Any]:
    # Gemini streams incremental text deltas across chunks; usage on the final chunk.
    return [
        SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    finish_reason=None,
                    content=SimpleNamespace(parts=[SimpleNamespace(text="Hello ", thought=False)]),
                )
            ],
            usage_metadata=None,
        ),
        SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    finish_reason=None,
                    content=SimpleNamespace(parts=[SimpleNamespace(text="world", thought=False)]),
                )
            ],
            usage_metadata=None,
        ),
        SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    finish_reason="STOP",
                    content=SimpleNamespace(parts=[]),
                )
            ],
            usage_metadata=SimpleNamespace(
                prompt_token_count=7,
                candidates_token_count=2,
                thoughts_token_count=0,
                cached_content_token_count=0,
            ),
        ),
    ]


def test_google_maps_text_and_usage():
    ensure_providers_registered()
    original = get_provider("google-generative-ai")
    fake = _FakeClient(_chunks())
    register_provider("google-generative-ai", GoogleProvider(client=fake))
    try:

        async def run() -> None:
            msg = await complete(_model(), Context(messages=[Message(role="user", content="hi")]))
            assert msg.text == "Hello world"
            assert msg.stop_reason == "stop"
            assert msg.usage.input == 7
            assert msg.usage.output == 2
            assert msg.usage.cost.total > 0.0
            assert fake.models.last_config["max_output_tokens"] == 1024

        asyncio.run(run())
    finally:
        register_provider("google-generative-ai", original)


def test_google_function_call_becomes_tooluse():
    ensure_providers_registered()
    original = get_provider("google-generative-ai")
    chunks = [
        SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    finish_reason="STOP",
                    content=SimpleNamespace(
                        parts=[
                            SimpleNamespace(
                                function_call=SimpleNamespace(name="echo", args={"x": 9})
                            )
                        ]
                    ),
                )
            ],
            usage_metadata=SimpleNamespace(
                prompt_token_count=3,
                candidates_token_count=1,
                thoughts_token_count=0,
                cached_content_token_count=0,
            ),
        )
    ]
    fake = _FakeClient(chunks)
    register_provider("google-generative-ai", GoogleProvider(client=fake))
    try:

        async def run() -> None:
            msg = await complete(
                _model(), Context(messages=[Message(role="user", content="run echo")])
            )
            assert msg.stop_reason == "toolUse"
            assert len(msg.tool_calls) == 1
            assert msg.tool_calls[0].name == "echo"
            assert msg.tool_calls[0].arguments == {"x": 9}

        asyncio.run(run())
    finally:
        register_provider("google-generative-ai", original)


def test_build_config_uses_parameters_json_schema_for_nested_tools():
    """Tools with a nested-model ($ref) schema (e.g. `tasks`) must go via
    `parameters_json_schema`, not the SDK's strict `parameters` Schema (which rejects $ref with
    a pydantic ValidationError and breaks the whole Gemini call)."""
    from minima_harness.ai import get_model
    from minima_harness.ai.providers import ensure_providers_registered
    from minima_harness.ai.providers.google import _build_config
    from minima_harness.ai.types import Context, Tool
    from minima_harness.minima.goals import GoalStore
    from minima_harness.tools.tasks import tasks_tool

    ensure_providers_registered()
    t = tasks_tool(GoalStore())  # nested TaskItem -> $ref/$defs in the schema
    ctx = Context(
        system_prompt="",
        messages=[],
        tools=[Tool(name=t.name, description=t.description, parameters=t.parameters)],
    )
    cfg = _build_config(get_model("google", "gemini-2.5-flash"), ctx, {})
    fd = cfg["tools"][0]["function_declarations"][0]
    assert "parameters_json_schema" in fd  # the JSON-schema path the SDK converts itself
    assert "parameters" not in fd  # NOT the strict Schema model that rejects $ref
