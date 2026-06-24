"""Tests for the harness /stats cost-optimality surfacing."""

from __future__ import annotations

from minima_harness.tui.analytics import cost_position_for, format_stats


def test_cost_position_cheapest_vs_priciest():
    cheap = cost_position_for({"gpt-4o-mini": 1})
    pricey = cost_position_for({"claude-opus-4-8": 1})
    assert cheap is not None and pricey is not None
    assert 0.0 <= cheap <= 1.0 and 0.0 <= pricey <= 1.0
    assert cheap < pricey
    assert pricey == 1.0  # opus is the priciest model in the pool
    assert cheap == 0.0  # gpt-4o-mini is the cheapest


def test_cost_position_none_when_unresolvable():
    assert cost_position_for({"nonexistent-model": 3}) is None
    assert cost_position_for({}) is None


def test_format_stats_includes_cost_position():
    stats = {
        "sessions": 1,
        "prompts": 2,
        "total_in": 10,
        "total_out": 5,
        "total_cost": 0.01,
        "per_model": {"gpt-4o-mini": 2},
        "cost_position": 0.05,
    }
    out = format_stats(stats)
    assert "cost position: 0.05" in out
    assert "models:" in out


def test_format_stats_omits_cost_position_when_absent():
    stats = {
        "sessions": 0,
        "prompts": 0,
        "total_in": 0,
        "total_out": 0,
        "total_cost": 0.0,
        "per_model": {},
        "cost_position": None,
    }
    assert "cost position" not in format_stats(stats)
