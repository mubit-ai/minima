from __future__ import annotations

import pytest

from minima.config import Settings
from minima.main import create_app
from minima_harness.ai import get_model
from minima_harness.ai.providers import ensure_providers_registered, get_provider, register_provider
from minima_harness.ai.providers.anthropic import AnthropicProvider
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.router import MinimaRouter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tools import default_toolset
from minima_harness.tui.app import HarnessApp
from tests.factories import FakeMemory
from tests.harness.test_minima_e2e import TEST_KEY, _asgi_client, _fake_anthropic_client


@pytest.mark.asyncio
async def test_app_streams_a_turn_through_minima():
    memory = FakeMemory()
    app_svc = create_app(
        settings=Settings(mubit_api_key="test-key"), memory=memory, start_refresh=False
    )
    ensure_providers_registered()
    original = get_provider("anthropic-messages")
    register_provider(
        "anthropic-messages", AnthropicProvider(client=_fake_anthropic_client("the answer is 42"))
    )
    try:
        async with app_svc.router.lifespan_context(app_svc):
            client = _asgi_client(app_svc)
            cfg = HarnessConfig(
                minima_url="http://testserver",
                minima_api_key=TEST_KEY,
                candidates=["claude-haiku-4-5"],
                judge_every=0,
                allow_offline=True,
            )
            router = MinimaRouter(client, cfg)
            agent = MinimaAgent(
                cfg,
                router=router,
                tools=default_toolset(),
                model=get_model("anthropic", "claude-haiku-4-5"),
                meter=CostMeter(),
            )
            tui = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)

            async with tui.run_test() as pilot:
                await tui.run_turn("what is the answer")
                await pilot.pause()

            # The bridge accumulated the streamed assistant text.
            assert tui.bridge.assistant_text == "the answer is 42"
            assert tui.bridge.finished is True
            # The meter recorded exactly one routed turn.
            assert tui.agent.meter is not None
            assert tui.agent.meter.totals().n == 1
    finally:
        register_provider("anthropic-messages", original)
