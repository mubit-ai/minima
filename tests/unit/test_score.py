from __future__ import annotations

import pytest

from costit.recommender import score
from costit.recommender.types import ModelAggregate
from costit.schemas.common import TaskType
from costit.schemas.models_catalog import ModelCard


def _card(**kw) -> ModelCard:
    base = {
        "model_id": "m",
        "provider": "p",
        "input_cost_per_mtok": 1.0,
        "output_cost_per_mtok": 2.0,
    }
    base.update(kw)
    return ModelCard(**base)


def test_threshold_endpoints():
    assert score.threshold_from_slider(0, 0.55, 0.92) == pytest.approx(0.55)
    assert score.threshold_from_slider(10, 0.55, 0.92) == pytest.approx(0.92)
    mid = score.threshold_from_slider(5, 0.55, 0.92)
    assert 0.55 < mid < 0.92


def test_threshold_respects_min_quality():
    assert score.threshold_from_slider(0, 0.55, 0.92, min_quality=0.8) == pytest.approx(0.8)


def test_ranking_score_quality_only_at_max_slider():
    # cq=10 -> lambda=1.0 -> cost term vanishes
    assert score.ranking_score(0.9, 1.0, 10) == pytest.approx(0.9)
    # cheaper option wins at low slider when quality equal
    cheap = score.ranking_score(0.8, 0.1, 0)
    pricey = score.ranking_score(0.8, 0.9, 0)
    assert cheap > pricey


def test_predicted_success_no_evidence_returns_prior():
    p, conf = score.predicted_success(None, prior=0.7, pseudocount=4.0)
    assert p == pytest.approx(0.7)
    assert conf == 0.0


def test_predicted_success_blends_toward_evidence():
    agg = ModelAggregate(model_id="m", weight_sum=4.0, weighted_success=4.0, n=4)
    p, conf = score.predicted_success(agg, prior=0.5, pseudocount=4.0)
    # all-success evidence pulls above the 0.5 prior
    assert p > 0.5
    assert 0 < conf < 1


def test_estimate_cost_uses_cache_price_when_enabled():
    card = _card(cache_read_cost_per_mtok=0.1)
    full, _ = score.estimate_cost(card, 1_000_000, 0, use_cache=False)
    cached, _ = score.estimate_cost(card, 1_000_000, 0, use_cache=True)
    assert full == pytest.approx(1.0)
    assert cached == pytest.approx(0.1)


def test_capability_prior_fallback_chain():
    by_type = _card(capability_by_task_type={"code": 0.8})
    assert score.capability_prior(by_type, TaskType.code) == pytest.approx(0.8)
    intel = _card(capability_priors={"intelligence_index": 0.6})
    assert score.capability_prior(intel, TaskType.code) == pytest.approx(0.6)
    bare = _card()
    assert score.capability_prior(bare, TaskType.code) == pytest.approx(0.5)
