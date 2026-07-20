"""Phase 4B: the SDK's typed Usage teaches the loop's biggest accuracy lever."""

from __future__ import annotations

import pytest
from minima_client.client import Usage, _feedback_request


def test_usage_populates_realized_fields():
    req = _feedback_request(
        "rec-1",
        "claude-haiku-4-5",
        "success",
        usage=Usage(input_tokens=1200, output_tokens=400, cost_usd=0.0021, latency_ms=800),
        quality_score=0.9,
        evidence_source="judge",
    )
    assert req.input_tokens == 1200
    assert req.output_tokens == 400
    assert req.actual_cost_usd == pytest.approx(0.0021)
    assert req.latency_ms == 800
    assert req.evidence_source == "judge"


def test_explicit_kwargs_win_over_usage():
    req = _feedback_request(
        "rec-1",
        "m",
        "success",
        usage=Usage(cost_usd=0.001),
        actual_cost_usd=0.002,
    )
    assert req.actual_cost_usd == pytest.approx(0.002)


def test_unmeasured_usage_fields_stay_absent():
    req = _feedback_request("rec-1", "m", "success", usage=Usage())
    assert req.input_tokens is None
    assert req.actual_cost_usd is None


def test_explicit_zero_is_a_real_measurement():
    req = _feedback_request(
        "rec-1", "m", "success", usage=Usage(input_tokens=0, output_tokens=0, cost_usd=0.0)
    )
    assert req.input_tokens == 0
    assert req.output_tokens == 0
    assert req.actual_cost_usd == 0.0
