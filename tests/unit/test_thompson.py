"""Tests for Thompson (posterior-sampling) selection."""

from __future__ import annotations

import random

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender import score
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.recommender.types import ModelAggregate
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory


def test_beta_params_no_evidence_is_prior():
    a, b = score.beta_params(None, prior=0.6, pseudocount=2.5)
    assert a == 0.6 * 2.5
    assert b == 0.4 * 2.5


def test_beta_params_with_evidence():
    agg = ModelAggregate(model_id="m", weight_sum=10.0, weighted_success=7.0, n=10)
    a, b = score.beta_params(agg, prior=0.5, pseudocount=2.0)
    assert a == 7.0 + 0.5 * 2.0  # weighted_success + alpha0
    assert b == (10.0 - 7.0) + 0.5 * 2.0  # failures + beta0
    assert a / (a + b) > 0.5  # success-leaning


def test_thompson_select_prefers_cheapest_that_clears_tau():
    rng = random.Random(0)
    items = [
        ("weak_cheap", 1.0, 20.0, 0.0005),  # cheapest but ~0.05 success -> rarely clears tau
        ("cheap", 50.0, 5.0, 0.001),  # ~0.91 success, cheap
        ("pricey", 50.0, 5.0, 0.010),  # ~0.91 success, expensive
    ]
    pick, propensities = score.thompson_select(items, tau=0.7, rng=rng, samples=500)
    assert abs(sum(propensities.values()) - 1.0) < 1e-9
    assert pick in {"weak_cheap", "cheap", "pricey"}
    # weak_cheap rarely clears tau despite being cheapest
    assert propensities["weak_cheap"] < 0.1
    # among the two that clear tau, the cheaper one dominates
    assert propensities["cheap"] > propensities["pricey"]
    assert propensities["cheap"] == max(propensities.values())


def test_thompson_select_empty():
    assert score.thompson_select([], tau=0.7, rng=random.Random(0), samples=10) == ("", {})


async def test_engine_uses_thompson_policy_when_org_opted_in():
    settings = Settings(mubit_api_key="t", minima_thompson_selection_orgs="default")
    engine = Recommender(settings, FakeMemory(), CatalogStore(settings), RecommendationStore())
    req = RecommendRequest(
        task=TaskInput(task="write a python function", task_type="code"),
        allow_llm_escalation=False,
        constraints=Constraints(
            candidate_models=["gpt-4o-mini", "gemini-2.5-flash", "gemini-2.5-pro"]
        ),
    )
    resp = await engine.recommend(req)
    assert resp.selection_policy == "thompson"
    assert resp.recommended_model.model_id in {
        "gpt-4o-mini",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
    }
