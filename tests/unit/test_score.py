from __future__ import annotations

import pytest

from minima.recommender import score
from minima.recommender.aggregate import aggregate_by_model
from minima.recommender.types import ModelAggregate
from minima.schemas.common import TaskType
from minima.schemas.models_catalog import ModelCard
from tests.factories import make_evidence


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


def _agg(cost: float = 0.0, out_tokens: int = 0, k: int = 3) -> ModelAggregate:
    return aggregate_by_model([
        make_evidence("m", 1.0, entry_id=f"e{i}", cost_usd=cost, output_tokens=out_tokens)
        for i in range(k)
    ])["m"]


def test_effective_cost_observed_basis_uses_median_cost():
    card = _card(input_cost_per_mtok=0.5, output_cost_per_mtok=3.0)
    cost, breakdown = score.effective_cost(
        card, _agg(cost=0.10, k=3), 1000, 256, use_cache=False, basis="observed", min_cost_n=3
    )
    assert cost == pytest.approx(0.10)
    assert "observed_avg" in breakdown


def test_effective_cost_observed_falls_back_below_min_n():
    card = _card(input_cost_per_mtok=1.0, output_cost_per_mtok=2.0)
    cost, breakdown = score.effective_cost(
        card, _agg(cost=0.10, k=2), 1_000_000, 0, use_cache=False, basis="observed", min_cost_n=3
    )
    assert cost == pytest.approx(1.0)  # token estimate (too few observations)
    assert "observed_avg" not in breakdown


def test_effective_cost_estimate_basis():
    card = _card(input_cost_per_mtok=1.0, output_cost_per_mtok=2.0)
    cost, _ = score.effective_cost(
        card, _agg(cost=0.10, k=9), 1_000_000, 0, use_cache=False, basis="estimate", min_cost_n=3
    )
    assert cost == pytest.approx(1.0)


def test_effective_cost_rescaled_uses_request_input_and_observed_output():
    # current request input 100 tok @ $2/Mtok + model's observed 2000 output tok @ $10/Mtok
    card = _card(input_cost_per_mtok=2.0, output_cost_per_mtok=10.0)
    cost, breakdown = score.effective_cost(
        card, _agg(cost=0.05, out_tokens=2000, k=3), 100, 50,
        use_cache=False, basis="rescaled", min_cost_n=3,
    )
    expected = 100 / 1e6 * 2.0 + 2000 / 1e6 * 10.0  # request input + observed (thinking) output
    assert cost == pytest.approx(expected)
    assert breakdown["obs_output_tokens"] == pytest.approx(2000)


def test_choose_cost_basis_tiers():
    rescale_ready = _agg(cost=0.05, out_tokens=2000, k=3)
    cost_only = _agg(cost=0.05, k=3)
    assert score.choose_cost_basis({"m": rescale_ready}, True, False, 3) == "rescaled"
    assert score.choose_cost_basis({"m": cost_only}, True, False, 3) == "observed"
    # rescaled honors caching (input priced at cache rate); cost-only observed is gated off
    assert score.choose_cost_basis({"m": rescale_ready}, True, True, 3) == "rescaled"
    assert score.choose_cost_basis({"m": cost_only}, True, True, 3) == "estimate"
    # disabled, mixed-evidence, and missing-agg all fall to estimate / lowest common tier
    assert score.choose_cost_basis({"m": rescale_ready}, False, False, 3) == "estimate"
    mixed = {"a": rescale_ready, "b": cost_only}
    assert score.choose_cost_basis(mixed, True, False, 3) == "observed"
    assert score.choose_cost_basis({"a": rescale_ready, "b": None}, True, False, 3) == "estimate"


def test_capability_prior_fallback_chain():
    by_type = _card(capability_by_task_type={"code": 0.8})
    assert score.capability_prior(by_type, TaskType.code) == pytest.approx(0.8)
    intel = _card(capability_priors={"intelligence_index": 0.6})
    assert score.capability_prior(intel, TaskType.code) == pytest.approx(0.6)
    bare = _card()
    assert score.capability_prior(bare, TaskType.code) == pytest.approx(0.5)
