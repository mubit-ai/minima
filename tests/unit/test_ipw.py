from __future__ import annotations

import pytest

from minima.recommender.aggregate import apply_ipw
from minima.recommender.propensity import PropensityTracker
from minima.recommender.types import ModelAggregate


def test_propensities_are_laplace_smoothed_and_sum_to_one():
    tracker = PropensityTracker()
    tracker.record("lane", "code:hard", "a")
    tracker.record("lane", "code:hard", "a")
    tracker.record("lane", "code:hard", "b")
    props = tracker.propensities("lane", "code:hard", ["a", "b", "c"])
    # counts a=2, b=1, c=0; total=3, m=3, denom=6
    assert props["a"] == pytest.approx(3 / 6)
    assert props["b"] == pytest.approx(2 / 6)
    assert props["c"] == pytest.approx(1 / 6)
    assert sum(props.values()) == pytest.approx(1.0)


def test_propensities_isolated_by_lane_and_cluster():
    tracker = PropensityTracker()
    tracker.record("lane1", "code:hard", "a")
    other = tracker.propensities("lane2", "code:hard", ["a", "b"])
    # nothing recorded in lane2 -> uniform
    assert other["a"] == pytest.approx(0.5)
    assert other["b"] == pytest.approx(0.5)


def test_apply_ipw_upweights_low_propensity_preserving_rate():
    aggs = {
        "rare": ModelAggregate(model_id="rare", weight_sum=1.0, weighted_success=1.0, n=1),
        "common": ModelAggregate(model_id="common", weight_sum=1.0, weighted_success=0.5, n=2),
    }
    apply_ipw(aggs, {"rare": 0.1, "common": 0.9}, clip_low=0.1, clip_high=10.0)
    assert aggs["rare"].weight_sum == pytest.approx(10.0)  # 1/0.1 = 10, at clip ceiling
    assert aggs["common"].weight_sum == pytest.approx(1 / 0.9)
    # success rate is unchanged by the rescale
    assert aggs["rare"].weighted_success_rate == pytest.approx(1.0)
    assert aggs["common"].weighted_success_rate == pytest.approx(0.5)


def test_apply_ipw_clips_extremes():
    aggs = {"m": ModelAggregate(model_id="m", weight_sum=2.0, weighted_success=2.0, n=1)}
    apply_ipw(aggs, {"m": 0.001}, clip_low=0.1, clip_high=5.0)
    assert aggs["m"].weight_sum == pytest.approx(10.0)  # 2.0 * clip_high(5.0)
