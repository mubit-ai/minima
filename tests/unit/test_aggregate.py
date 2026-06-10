from __future__ import annotations

import pytest

from costit.recommender.aggregate import (
    KC_FLOOR,
    aggregate_by_model,
    is_conflicted,
    neighbor_weight,
)
from costit.recommender.types import ModelAggregate
from tests.factories import make_evidence


def test_neighbor_weight_floor_and_stale():
    fresh = make_evidence("m", 1.0, entry_id="e", score=1.0, knowledge_confidence=0.0)
    # kc=0 still counts at the floor
    assert neighbor_weight(fresh) == pytest.approx(KC_FLOOR)
    stale = make_evidence(
        "m", 1.0, entry_id="e", score=1.0, knowledge_confidence=1.0, is_stale=True
    )
    assert neighbor_weight(stale) == pytest.approx(0.5)


def test_aggregate_groups_and_weights():
    evidence = [
        make_evidence("a", 1.0, entry_id="1", score=1.0, knowledge_confidence=1.0),
        make_evidence("a", 0.0, entry_id="2", score=1.0, knowledge_confidence=1.0),
        make_evidence("b", 1.0, entry_id="3", score=1.0, knowledge_confidence=1.0),
    ]
    aggs = aggregate_by_model(evidence)
    assert set(aggs) == {"a", "b"}
    assert aggs["a"].n == 2
    assert aggs["a"].weighted_success_rate == pytest.approx(0.5)
    assert aggs["b"].weighted_success_rate == pytest.approx(1.0)


def test_aggregate_candidate_filter():
    evidence = [make_evidence("a", 1.0, entry_id="1"), make_evidence("b", 1.0, entry_id="2")]
    aggs = aggregate_by_model(evidence, candidate_ids={"a"})
    assert set(aggs) == {"a"}


def test_observed_cost_is_robust_median():
    evidence = [
        make_evidence("a", 1.0, entry_id="1", cost_usd=0.01),
        make_evidence("a", 1.0, entry_id="2", cost_usd=0.01),
        make_evidence("a", 1.0, entry_id="3", cost_usd=0.01),
        make_evidence("a", 1.0, entry_id="4", cost_usd=5.0),  # outlier ignored by the median
        make_evidence("b", 1.0, entry_id="5"),  # no cost_usd
    ]
    aggs = aggregate_by_model(evidence)
    # similarity-weighted median shrugs off the $5 outlier
    assert aggs["a"].observed_cost(min_n=3) == pytest.approx(0.01)
    # below the minimum count -> None (fall back to estimate)
    assert aggs["a"].observed_cost(min_n=9) is None
    # no cost-bearing evidence -> None
    assert aggs["b"].observed_cost(min_n=1) is None


def test_observed_output_tokens_robust_median():
    evidence = [
        make_evidence("a", 1.0, entry_id="1", output_tokens=1000),
        make_evidence("a", 1.0, entry_id="2", output_tokens=1000),
        make_evidence("a", 1.0, entry_id="3", output_tokens=1000),
        make_evidence("a", 1.0, entry_id="4", output_tokens=99999),  # outlier ignored
        make_evidence("b", 1.0, entry_id="5"),  # no output_tokens
    ]
    aggs = aggregate_by_model(evidence)
    assert aggs["a"].observed_output_tokens(min_n=3) == pytest.approx(1000)
    assert aggs["a"].observed_output_tokens(min_n=9) is None
    assert aggs["b"].observed_output_tokens(min_n=1) is None


def test_is_conflicted():
    split = ModelAggregate(model_id="m", weight_sum=4.0, weighted_success=2.0, n=4)
    assert is_conflicted(split)
    clear = ModelAggregate(model_id="m", weight_sum=4.0, weighted_success=3.8, n=4)
    assert not is_conflicted(clear)
    too_few = ModelAggregate(model_id="m", weight_sum=2.0, weighted_success=1.0, n=2)
    assert not is_conflicted(too_few)
