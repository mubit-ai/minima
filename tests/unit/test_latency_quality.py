"""Latency percentiles, the quality/outcome consistency gate, and selection helpers."""

from __future__ import annotations

import pytest

from minima.memory.records import reconcile_quality
from minima.recommender.aggregate import aggregate_by_model
from minima.recommender.score import posterior_interval_width, softmax_propensities
from minima.recommender.types import _weighted_quantile
from tests.factories import make_evidence


class TestWeightedQuantile:
    def test_median_matches_legacy(self):
        pairs = [(1.0, 1.0), (2.0, 1.0), (3.0, 1.0)]
        assert _weighted_quantile(pairs, 0.5) == 2.0

    def test_p75_leans_high(self):
        pairs = [(100.0, 1.0), (200.0, 1.0), (300.0, 1.0), (400.0, 1.0)]
        assert _weighted_quantile(pairs, 0.75) == 300.0

    def test_weights_shift_the_quantile(self):
        pairs = [(100.0, 10.0), (5000.0, 0.1)]
        assert _weighted_quantile(pairs, 0.75) == 100.0

    def test_zero_weights_fall_back_to_positional(self):
        pairs = [(1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (4.0, 0.0)]
        assert _weighted_quantile(pairs, 0.75) == 4.0


class TestObservedLatency:
    def test_requires_min_n(self):
        evs = [
            make_evidence("m", 0.9, entry_id=f"e{i}", latency_ms=1000 + i * 100)
            for i in range(2)
        ]
        aggs = aggregate_by_model(evs, {"m"})
        assert aggs["m"].observed_latency_ms(min_n=3) is None

    def test_p75_over_latency_bearing_neighbors(self):
        evs = [
            make_evidence("m", 0.9, entry_id=f"e{i}", latency_ms=ms)
            for i, ms in enumerate([1000, 2000, 3000, 4000])
        ]
        # One neighbor without latency must not count toward min_n or the quantile.
        evs.append(make_evidence("m", 0.9, entry_id="e-null"))
        aggs = aggregate_by_model(evs, {"m"})
        assert aggs["m"].observed_latency_ms(min_n=3, q=0.75) == 3000.0


class TestReconcileQuality:
    def test_contradictory_failure_clamped(self):
        quality, warning = reconcile_quality("failure", 0.95)
        assert quality == 0.6
        assert warning == "quality_outcome_mismatch"

    def test_contradictory_success_clamped(self):
        quality, warning = reconcile_quality("success", 0.05)
        assert quality == 0.4
        assert warning == "quality_outcome_mismatch"

    def test_nuanced_feedback_passes_through(self):
        assert reconcile_quality("success", 0.55) == (0.55, None)
        assert reconcile_quality("failure", 0.3) == (0.3, None)
        assert reconcile_quality("partial", 0.95) == (0.95, None)


class TestPosteriorIntervalWidth:
    def test_no_evidence_is_maximal_uncertainty(self):
        assert posterior_interval_width(None, prior=0.7, pseudocount=2.5) == 1.0

    def test_width_shrinks_with_evidence(self):
        few = aggregate_by_model(
            [make_evidence("m", 0.9, entry_id=f"e{i}", score=1.0) for i in range(2)], {"m"}
        )["m"]
        many = aggregate_by_model(
            [make_evidence("m", 0.9, entry_id=f"e{i}", score=1.0) for i in range(40)], {"m"}
        )["m"]
        w_few = posterior_interval_width(few, prior=0.7, pseudocount=2.5)
        w_many = posterior_interval_width(many, prior=0.7, pseudocount=2.5)
        assert w_many < w_few < 1.0


class TestSoftmaxPropensities:
    def test_sums_to_one_and_argmin_dominates(self):
        pi = softmax_propensities(
            {"a": 0.9, "b": 0.7, "c": 0.5}, argmin_id="b", epsilon=0.03, temperature=0.1
        )
        assert sum(pi.values()) == pytest.approx(1.0)
        assert pi["b"] > 0.9  # (1 - eps) + its softmax share
        assert all(p > 0 for p in pi.values())  # every eligible candidate is explorable

    def test_epsilon_zero_is_degenerate(self):
        pi = softmax_propensities(
            {"a": 0.9, "b": 0.7}, argmin_id="a", epsilon=0.0, temperature=0.1
        )
        assert pi == {"a": 1.0, "b": 0.0}
