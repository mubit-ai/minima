from __future__ import annotations

import pytest

from minima.recommender.aggregate import (
    KC_FLOOR,
    aggregate_by_model,
    is_conflicted,
    neighbor_weight,
)
from minima.recommender.types import ModelAggregate
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


def test_label_model_scores_none_is_identical():
    evidence = [
        make_evidence("a", 1.0, entry_id="1", score=1.0, knowledge_confidence=1.0),
        make_evidence("a", 0.0, entry_id="2", score=1.0, knowledge_confidence=1.0),
        make_evidence("b", 1.0, entry_id="3", score=0.8, knowledge_confidence=0.6),
    ]
    for ev in evidence:
        assert ev.record is not None
        ev.record.recommendation_id = f"r{ev.entry_id}"
    default = aggregate_by_model(evidence)
    explicit_none = aggregate_by_model(evidence, label_model_scores=None)
    for model_id, agg in default.items():
        other = explicit_none[model_id]
        assert other.weight_sum == agg.weight_sum
        assert other.weighted_success == agg.weighted_success
        assert other.n == agg.n


def test_label_model_scores_override_non_gate_rows_only():
    ev_judge = make_evidence("a", 1.0, entry_id="1", score=1.0, knowledge_confidence=1.0)
    ev_gate = make_evidence(
        "b", 1.0, entry_id="2", score=1.0, knowledge_confidence=1.0, evidence_source="gate"
    )
    assert ev_judge.record is not None and ev_gate.record is not None
    ev_judge.record.recommendation_id = "r1"
    ev_gate.record.recommendation_id = "r2"
    aggs = aggregate_by_model([ev_judge, ev_gate], label_model_scores={"r1": 0.25, "r2": 0.25})
    assert aggs["a"].weighted_success_rate == pytest.approx(0.25)
    # The gate anchor is never overridden by the label model.
    assert aggs["b"].weighted_success_rate == pytest.approx(1.0)


def test_label_model_scores_counter_path_swaps_latest_outcome_only():
    ev = make_evidence("a", 1.0, entry_id="1", score=1.0, knowledge_confidence=1.0)
    rec = ev.record
    assert rec is not None
    rec.recommendation_id = "r1"
    rec.n_outcomes = 2
    rec.success_mass = 2.0
    aggs = aggregate_by_model([ev], label_model_scores={"r1": 0.5})
    # latest label_score is 1.0; only that unit is swapped: (2.0 - 1.0 + 0.5) / 2
    assert aggs["a"].weighted_success_rate == pytest.approx(0.75)


def test_label_model_scores_unknown_rec_id_is_untouched():
    ev = make_evidence("a", 1.0, entry_id="1", score=1.0, knowledge_confidence=1.0)
    assert ev.record is not None
    ev.record.recommendation_id = "r1"
    aggs = aggregate_by_model([ev], label_model_scores={"other": 0.1})
    assert aggs["a"].weighted_success_rate == pytest.approx(1.0)


def test_is_conflicted():
    split = ModelAggregate(model_id="m", weight_sum=4.0, weighted_success=2.0, n=4)
    assert is_conflicted(split)
    clear = ModelAggregate(model_id="m", weight_sum=4.0, weighted_success=3.8, n=4)
    assert not is_conflicted(clear)
    too_few = ModelAggregate(model_id="m", weight_sum=2.0, weighted_success=1.0, n=2)
    assert not is_conflicted(too_few)
