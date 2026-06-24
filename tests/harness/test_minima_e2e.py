"""Full hermetic E2E: MinimaAgent round-trips recommend -> run -> judge -> feedback
through a REAL in-process Minima (create_app + FakeMemory) via the bundled
AsyncMinimaClient on an ASGI transport, with a fake Anthropic provider standing in for
the model call. No network, no API keys, no Mubit.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest
from minima_client import AsyncMinimaClient

from minima.config import Settings
from minima.main import create_app
from minima_harness.ai import get_model
from minima_harness.ai.providers import (
    ensure_providers_registered,
    get_provider,
    register_provider,
)
from minima_harness.ai.providers.anthropic import AnthropicProvider
from minima_harness.minima import HarnessConfig, MinimaAgent, MinimaRouter
from minima_harness.minima.judge import DeterministicJudge
from tests.factories import FakeMemory

TEST_KEY = "mbt_test_kid_secret"


def _fake_anthropic_client(text: str, *, in_tokens: int = 12, out_tokens: int = 6):
    """Stand-in AsyncAnthropic whose ``messages.stream`` yields canned raw events."""

    def events():
        yield SimpleNamespace(
            type="message_start",
            message=SimpleNamespace(
                usage=SimpleNamespace(
                    input_tokens=in_tokens,
                    cache_read_input_tokens=0,
                    cache_creation_input_tokens=0,
                )
            ),
        )
        yield SimpleNamespace(
            type="content_block_start", index=0, content_block=SimpleNamespace(type="text")
        )
        yield SimpleNamespace(
            type="content_block_delta", index=0, delta=SimpleNamespace(type="text_delta", text=text)
        )
        yield SimpleNamespace(type="content_block_stop", index=0)
        yield SimpleNamespace(
            type="message_delta",
            delta=SimpleNamespace(stop_reason="end_turn"),
            usage=SimpleNamespace(output_tokens=out_tokens),
        )
        yield SimpleNamespace(type="message_stop")

    class _Stream:
        def __aiter__(self):
            async def _gen():
                for e in events():
                    yield e

            return _gen()

    class _Mgr:
        async def __aenter__(self):
            return _Stream()

        async def __aexit__(self, *exc: object) -> None:
            return None

    class _Messages:
        def stream(self, **kwargs):
            return _Mgr()

    class _Client:
        def __init__(self):
            self.messages = _Messages()

    return _Client()


def _asgi_client(app) -> AsyncMinimaClient:
    c = AsyncMinimaClient("http://testserver", TEST_KEY, timeout=30.0)
    c._client = httpx.AsyncClient(  # type: ignore[attr-defined]
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {TEST_KEY}"},
        timeout=30.0,
    )
    return c


def test_full_loop_round_trips_through_minima():
    memory = FakeMemory()
    app = create_app(
        settings=Settings(mubit_api_key="test-key"),
        memory=memory,
        start_refresh=False,
    )
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    register_provider(
        "anthropic-messages", AnthropicProvider(client=_fake_anthropic_client("the answer is 42"))
    )
    routing = None
    try:

        async def driver():
            # ASGITransport skips the app lifespan; run it so app.state (passthrough_runtime,
            # catalog, etc.) is populated before the first request.
            async with app.router.lifespan_context(app):
                client = _asgi_client(app)
                config = HarnessConfig(
                    minima_url="http://testserver",
                    minima_api_key=TEST_KEY,
                    candidates=["claude-haiku-4-5"],
                    judge_every=1,
                )
                agent = MinimaAgent(
                    config,
                    router=MinimaRouter(client, config),
                    judge=DeterministicJudge(lambda t: 0.95),
                    model=get_model("anthropic", "claude-haiku-4-5"),
                    task_type="qa",
                )
                return await agent.prompt("what is the answer to life")

        routing = asyncio.run(driver())
    finally:
        register_provider("anthropic-messages", original)

    # 1) Minima recommended the only candidate and the harness ran it.
    assert routing is not None
    assert routing.chosen_model_id == "claude-haiku-4-5"
    # (final-message text asserted via memory below; the agent's messages list is intact)

    # 2) Feedback landed in Minima's memory with the judged quality + realized tokens.
    assert len(memory.remembered) == 1
    record = memory.remembered[0]["record"]
    assert record.model_id == "claude-haiku-4-5"
    assert record.quality_score == pytest.approx(0.95)
    assert record.outcome == "success"
    assert record.input_tokens == 12  # realized, from the provider
    assert record.output_tokens == 6
    assert record.cost_usd > 0.0  # rescaled cost basis (12*1.0 + 6*5.0 per MTok)
    assert record.latency_ms is not None and record.latency_ms >= 0
