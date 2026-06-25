"""Routing decision card (Phase 2c): hybrid reasoning, cost range, ROI, RoutingConfirm."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from minima_harness.minima.router import Ranking
from minima_harness.tui.app import (
    _fmt_cost_range,
    _fmt_latency,
    _roi_line,
    _routing_reason,
)


def _routing(
    chosen: str, ranked: list[Ranking], *, warnings=None, rationale="", low=None, high=None
):
    return SimpleNamespace(
        chosen_model_id=chosen,
        model=SimpleNamespace(id=chosen),
        ranked=ranked,
        decision_basis="memory",
        warnings=warnings or [],
        rationale=rationale,
        est_cost_usd=ranked[0].est_cost_usd,
        est_cost_low=low,
        est_cost_high=high,
        confidence=0.9,
        threshold_used=0.5,
    )


def test_fmt_cost_range():
    assert "no range yet" in _fmt_cost_range(0.01, None, None)
    assert _fmt_cost_range(0.01, 0.008, 0.018) == "$0.0100 ($0.0080–$0.0180)"


def test_fmt_latency():
    assert _fmt_latency(812.4) == "~812ms"
    assert _fmt_latency(None) == "~?ms"
    assert _fmt_latency(0) == "~?ms"


def test_roi_line_flags_low_value_premium():
    cheap = Ranking("flash", "g", 0.95, 0.0001, evidence_count=11)
    opus = Ranking("opus", "a", 0.97, 0.04)  # +2pp for +$0.04 -> not significant
    line = _roi_line(_routing("flash", [cheap, opus]))
    assert "opus" in line and "not-significant ROI" in line


def test_roi_line_worth_it_when_big_quality_gain():
    cheap = Ranking("flash", "g", 0.60, 0.0001, evidence_count=3)
    opus = Ranking("opus", "a", 0.95, 0.04)  # +35pp -> worth it
    line = _roi_line(_routing("flash", [cheap, opus]))
    assert "worth it for quality" in line


def test_routing_reason_data_grounded():
    cheap = Ranking("flash", "g", 0.95, 0.0001, evidence_count=11)
    opus = Ranking("opus", "a", 0.97, 0.04)
    reason = _routing_reason(_routing("flash", [cheap, opus]))
    assert "11 similar tasks" in reason
    assert "flash succeeds 95%" in reason
    assert "not-significant ROI" in reason


def test_routing_reason_uses_reasoner_when_escalated():
    r = _routing(
        "flash",
        [Ranking("flash", "g", 0.9, 0.001, evidence_count=0)],
        warnings=["reasoner_consulted"],
        rationale="Chose flash; the task is a simple summarization.",
    )
    assert _routing_reason(r) == "Chose flash; the task is a simple summarization."


def test_routing_reason_cold_start_uses_prior():
    r = _routing("flash", [Ranking("flash", "g", 0.7, 0.001, evidence_count=0)])
    assert "capability prior 70%" in _routing_reason(r)


@pytest.mark.asyncio
async def test_routing_confirm_renders_card_and_selects():
    from textual.app import App, ComposeResult
    from textual.widgets import Static

    from minima_harness.tui.overlays import RoutingConfirm

    cheap = Ranking(
        "flash", "g", 0.95, 0.0001, est_cost_low=0.0001, est_cost_high=0.0002,
        est_latency_ms=800, success_interval_width=0.08, evidence_count=11,
    )
    opus = Ranking("opus", "a", 0.97, 0.04)
    routing = _routing("flash", [cheap, opus])

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                RoutingConfirm(routing, "11 similar tasks · flash succeeds 95%"),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.screen.query_one("#route-card").border_title == "routing"
        await pilot.press("enter")  # select highlighted first candidate
        await pilot.pause()
    assert app.result == {"action": "select", "model_id": "flash"}


@pytest.mark.asyncio
async def test_routing_confirm_marks_no_key_candidates(monkeypatch):
    # A candidate whose provider key is missing is flagged "⚠ no key" so the user can see why
    # selecting it would fail (the run then reports the exact auth error).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    from textual.app import App, ComposeResult
    from textual.widgets import OptionList, Static

    from minima_harness.tui.overlays import RoutingConfirm

    haiku = Ranking("claude-haiku-4-5", "anthropic", 0.9, 0.001)
    gpt = Ranking("gpt-4o", "openai", 0.92, 0.01)
    routing = _routing("claude-haiku-4-5", [haiku, gpt])

    class _App(App):
        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(RoutingConfirm(routing))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        ol = app.screen.query_one(OptionList)
        labels = [str(ol.get_option_at_index(i).prompt) for i in range(ol.option_count)]

    haiku_label = next(label for label in labels if "claude-haiku" in label)
    gpt_label = next(label for label in labels if "gpt-4o" in label)
    assert "no key" not in haiku_label  # anthropic key set -> runnable
    assert "no key" in gpt_label  # no OPENAI key -> flagged


@pytest.mark.asyncio
async def test_route_hook_warns_when_pick_unresolved():
    # Selecting a model the harness can't resolve must warn and keep the routed model, not
    # silently fall back (the user's "I picked X but it ran the default" complaint).
    from minima_harness.ai import get_model
    from minima_harness.ai.providers import ensure_providers_registered
    from minima_harness.minima.config import HarnessConfig
    from minima_harness.minima.router import RoutingResult
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.tui.app import HarnessApp
    from minima_harness.tui.widgets.messages import ChatLog, MessageBubble

    ensure_providers_registered()
    model = get_model("anthropic", "claude-haiku-4-5")
    cfg = HarnessConfig(minima_url="", candidates=["claude-haiku-4-5"], allow_offline=True)
    agent = MinimaAgent(cfg, model=model)
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)

    ranked = [
        Ranking("claude-haiku-4-5", "anthropic", 0.9, 0.001),
        Ranking("ghost-model", "ghost", 0.95, 0.002),  # not in the registry
    ]
    routing = RoutingResult(
        recommendation_id="r",
        chosen_model_id="claude-haiku-4-5",
        model=model,
        est_cost_usd=0.001,
        decision_basis="memory",
        ranked=ranked,
        confidence=0.9,
    )

    async def fake_push(screen, wait_for_dismiss=False):  # noqa: ANN001
        return {"action": "select", "model_id": "ghost-model"}

    async with app.run_test() as pilot:
        app._route_mode = "confirm"
        app.push_screen = fake_push  # type: ignore[method-assign]
        result = await app._route_hook(routing, "do a thing")
        await pilot.pause()
        texts = " ".join(b.buffer for b in app.query_one(ChatLog).query(MessageBubble))

    assert "ghost-model" in texts  # warned about the unrunnable pick
    assert result.model is model  # kept the originally-routed model
    assert result.chosen_model_id == "claude-haiku-4-5"


@pytest.mark.asyncio
async def test_model_auto_command_unpins(monkeypatch):
    # `/model auto` releases a pin and restores the full runnable candidate pool. Clear provider
    # keys so runnable_candidates is deterministic (falls back to all DEFAULT_CANDIDATES).
    from minima_harness.ai import get_model
    from minima_harness.ai.provider_catalog import PROVIDERS, runnable_candidates
    from minima_harness.ai.providers import ensure_providers_registered
    from minima_harness.minima.config import DEFAULT_CANDIDATES, HarnessConfig
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.tui.app import HarnessApp

    for p in PROVIDERS:
        for var in p.env_vars:
            monkeypatch.delenv(var, raising=False)

    ensure_providers_registered()
    model = get_model("anthropic", "claude-haiku-4-5")
    cfg = HarnessConfig(minima_url="", candidates=["claude-haiku-4-5"], allow_offline=True)
    agent = MinimaAgent(cfg, model=model)
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)

    async with app.run_test() as pilot:
        assert app.config.candidates == ["claude-haiku-4-5"]  # pinned
        await app._dispatch_command("model", "auto")
        await pilot.pause()

    assert app.config.candidates == runnable_candidates(list(DEFAULT_CANDIDATES))
    assert len(app.config.candidates) > 1  # restored to the routing pool, not the single pin
