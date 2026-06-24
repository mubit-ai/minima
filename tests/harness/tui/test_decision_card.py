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
