from __future__ import annotations

from types import SimpleNamespace

import pytest
from textual.app import App, ComposeResult
from textual.widgets import OptionList, Static

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import _confidence_band, _reasoner_note
from minima_harness.tui.overlays import ModelPicker
from minima_harness.tui.widgets.footer import render_footer


def test_footer_shows_model_and_basis_explicitly():
    text = str(
        render_footer("d", "s", "gemini-2.5-flash", "memory", CostMeter(), 1, 2, 0, 0, 12.0, False)
    )
    assert "model: gemini-2.5-flash ▸ memory" in text
    assert "ctx 12%" in text


def _routing(predicted: float, tau: float, confidence: float, warnings: list[str] | None = None):
    return SimpleNamespace(
        chosen_model_id="m",
        model=SimpleNamespace(id="m"),
        ranked=[SimpleNamespace(model_id="m", predicted_success=predicted)],
        threshold_used=tau,
        confidence=confidence,
        warnings=list(warnings or []),
    )


def test_confidence_band_green_amber_red():
    assert _confidence_band(_routing(0.9, 0.7, 0.8))[1] == "green"  # confident + clears
    assert _confidence_band(_routing(0.9, 0.7, 0.2))[1] == "yellow"  # clears but uncertain
    assert _confidence_band(_routing(0.6, 0.7, 0.9))[1] == "red"  # doesn't clear tau
    assert _confidence_band(_routing(0.9, 0.7, 0.9, ["no_model_meets_threshold"]))[1] == "red"


def test_reasoner_note_surfaces_escalation():
    assert "reasoner" in _reasoner_note(_routing(0.9, 0.7, 0.8, ["reasoner_consulted"]))
    assert "thin" in _reasoner_note(_routing(0.9, 0.7, 0.8, ["escalation_suggested:thin_evidence"]))
    assert _reasoner_note(_routing(0.9, 0.7, 0.8, [])) == ""


def test_footer_shows_route_mode():
    s = str(
        render_footer(
            "d", "s", "m", "memory", CostMeter(), 1, 2, 0, 0, 1.0, False, route_mode="confirm"
        )
    )
    assert "route: confirm" in s


@pytest.mark.asyncio
async def test_scroll_actions_run_without_error(tmp_path):
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    async with app.run_test():
        app.action_scroll_up()  # paging the transcript should not raise
        app.action_scroll_down()


@pytest.mark.asyncio
async def test_after_turn_uses_config_banner_for_auth_offline(tmp_path):
    """A non-retryable (auth/config) offline fallback shows the actionable banner, not
    the transient '/reconnect to retry' framing."""
    from textual.widgets import Static

    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    async with app.run_test() as pilot:
        app.agent._offline_reason = "no Mubit API key — add MUBIT_API_KEY via /config"
        app.agent._offline_retryable = False
        app._after_turn(None)
        await pilot.pause()
        banner = str(app.query_one("#banner", Static).render())
        assert "MUBIT_API_KEY" in banner and "/config" in banner
        assert "reconnect" not in banner.lower()

        # a retryable cause still uses the /reconnect banner
        app.agent._offline_reason = "Minima unreachable"
        app.agent._offline_retryable = True
        app._after_turn(None)
        await pilot.pause()
        banner = str(app.query_one("#banner", Static).render())
        assert "reconnect" in banner.lower()


@pytest.mark.asyncio
async def test_reconnect_command_rebuilds_client(tmp_path):
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    called: list = []

    async def _fake_reconnect():
        called.append(True)

    async with app.run_test() as pilot:
        app.agent.reconnect = _fake_reconnect  # type: ignore[method-assign]
        app._routing_offline = True
        await app._dispatch_command("reconnect", "")
        await pilot.pause()
    assert called == [True]  # /reconnect rebuilds the routing client, not just clears the banner
    assert app._routing_offline is False


@pytest.mark.asyncio
async def test_switching_model_clears_stale_banner(tmp_path):
    """Pinning/unpinning a model clears a prior model's error banner (no longer relevant)."""
    from textual.widgets import Static

    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    async with app.run_test() as pilot:
        app._set_model_error_banner("Access denied by Google Gemini … /model")
        app._routing_offline = True
        assert "Access denied" in str(app.query_one("#banner", Static).render())
        await app._dispatch_command("model", "auto")  # switch away from the failing model
        await pilot.pause()
        assert str(app.query_one("#banner", Static).render()).strip() == ""
        assert app._routing_offline is False


@pytest.mark.asyncio
async def test_provider_error_uses_model_error_banner_not_offline(tmp_path):
    """When routing SUCCEEDS but the model *call* fails (the Gemini-403 case), the banner must
    be the model-error one — not 'routing offline … /reconnect to retry Minima'."""
    from textual.widgets import Static

    from minima_harness.ai import AssistantMessage, TextContent
    from minima_harness.ai.providers import register_faux_provider
    from minima_harness.minima.mapping import ModelMapping
    from minima_harness.minima.router import RoutingResult
    from minima_harness.tui.app import HarnessApp

    with register_faux_provider() as reg:
        faux = reg.get_model()
        reg.set_responses(  # the model call returns a 403 (empty body, stop_reason="error")
            [
                AssistantMessage(
                    content=[TextContent(text="")],
                    stop_reason="error",
                    error_message="Client error '403 Forbidden'",
                )
            ]
        )

        class _OkRouter:  # routing succeeds → not the offline path
            mapping = ModelMapping()

            async def recommend(self, *a, **k):
                return RoutingResult(
                    recommendation_id="r1",
                    chosen_model_id=faux.id,
                    model=faux,
                    est_cost_usd=0.0,
                    decision_basis="memory",
                )

            async def feedback(self, *a, **k):
                pass

        cfg = HarnessConfig(candidates=["faux"], minima_api_key="test", judge_every=0)
        agent = MinimaAgent(cfg, router=_OkRouter(), model=faux)  # type: ignore[arg-type]
        app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent, cwd=tmp_path)
        async with app.run_test() as pilot:
            await app.run_turn("which is quickest?")
            await pilot.pause()
            banner = str(app.query_one("#banner", Static).render())

    assert app._routing_offline is False  # routing was fine; the model call failed
    assert "routing offline" not in banner.lower()
    assert "reconnect" not in banner.lower()
    assert "Access denied" in banner  # the actionable provider-error message is surfaced


@pytest.mark.asyncio
async def test_model_picker_titled_and_active_selectable():
    class _App(App):
        result: str | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                ModelPicker(
                    ["a", "b"],
                    active="a",
                    basis="memory",
                    pinned=None,
                    providers={"a": "anthropic"},
                ),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        # bordered OptionList card titled "model"; status moved to the border subtitle
        ol = app.screen.query_one(OptionList)
        assert ol.border_title == "model"
        assert "basis memory" in str(ol.border_subtitle)
        await pilot.press("down")  # row 0 is the auto/unpin entry; step to "a"
        await pilot.press("enter")
        await pilot.pause()
    assert app.result == "a"
