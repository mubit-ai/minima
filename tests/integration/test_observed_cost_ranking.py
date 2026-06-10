"""The recommender must rank by OBSERVED cost (from memory), not a flat token estimate.

Regression test for the reasoning-model cost bug: a model with low *list* prices but heavy
internal reasoning is expensive per call in reality. The flat token estimate mis-ranks it as
cheapest; ranking by the observed cost_usd recalled from memory corrects it.
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from minima.catalog.store import Catalog, CatalogStore
from minima.config import Settings
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.models_catalog import ModelCard
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence

REASONER_CHEAP_LISTED = "reasoner-cheap-listed"  # low list price, high real (thinking) cost
TRUE_CHEAP = "haiku-true-cheap"  # higher list price, low real cost


def _catalog(settings: Settings) -> CatalogStore:
    cards = [
        # Lower per-token list prices -> the flat estimate thinks this one is cheapest.
        ModelCard(model_id=REASONER_CHEAP_LISTED, provider="p",
                  input_cost_per_mtok=0.5, output_cost_per_mtok=3.0),
        # Higher list prices, but cheap in practice (few output tokens).
        ModelCard(model_id=TRUE_CHEAP, provider="p",
                  input_cost_per_mtok=1.0, output_cost_per_mtok=5.0),
    ]
    store = CatalogStore(settings)
    store.set(Catalog(cards=cards, version="t", refreshed_at=datetime.now(UTC),
                      cost_source="t", stale_after_seconds=10**9))
    return store


def _evidence() -> list:
    ev = []
    for i in range(3):  # >= minima_observed_cost_min_n so observed cost is trusted
        ev.append(make_evidence(REASONER_CHEAP_LISTED, 1.0, entry_id=f"r{i}", cost_usd=0.05))
        ev.append(make_evidence(TRUE_CHEAP, 1.0, entry_id=f"t{i}", cost_usd=0.01))
    return ev


REQ = RecommendRequest(
    task=TaskInput(task="write a function", task_type="code", difficulty="hard"),
    constraints=Constraints(candidate_models=[REASONER_CHEAP_LISTED, TRUE_CHEAP]),
    cost_quality_tradeoff=0.0,  # both clear the low bar -> cost decides
    allow_llm_escalation=False,
)


async def test_observed_cost_picks_truly_cheaper_model():
    settings = Settings(mubit_api_key="t")  # observed-cost ranking on by default
    engine = Recommender(
        settings, FakeMemory(_evidence()), _catalog(settings), RecommendationStore()
    )
    resp = await engine.recommend(REQ)
    assert resp.recommended_model.model_id == TRUE_CHEAP
    assert resp.recommended_model.est_cost_usd == pytest.approx(0.01, abs=1e-6)
    assert "obs" in resp.recommended_model.rationale


async def test_observed_cost_disabled_reverts_to_token_misranking():
    settings = Settings(mubit_api_key="t", minima_use_observed_cost=False)
    engine = Recommender(
        settings, FakeMemory(_evidence()), _catalog(settings), RecommendationStore()
    )
    resp = await engine.recommend(REQ)
    # Without the fix, the flat token estimate mis-ranks the reasoning model as cheapest.
    assert resp.recommended_model.model_id == REASONER_CHEAP_LISTED


def _one_card_catalog(settings: Settings) -> CatalogStore:
    card = ModelCard(model_id="m", provider="p",
                     input_cost_per_mtok=2.0, output_cost_per_mtok=10.0)
    store = CatalogStore(settings)
    store.set(Catalog(cards=[card], version="t", refreshed_at=datetime.now(UTC),
                      cost_source="t", stale_after_seconds=10**9))
    return store


async def test_rescaled_cost_uses_request_input_and_observed_output():
    # Records carry output_tokens -> the engine re-scales to THIS request's input size while
    # keeping the model's observed (thinking-inflated) output volume.
    settings = Settings(mubit_api_key="t")
    evidence = [make_evidence("m", 1.0, entry_id=f"e{i}", cost_usd=0.05, output_tokens=2000)
                for i in range(3)]
    engine = Recommender(
        settings, FakeMemory(evidence), _one_card_catalog(settings), RecommendationStore()
    )

    def _req(in_tokens: int) -> RecommendRequest:
        return RecommendRequest(
            task=TaskInput(task="do a thing", task_type="code", difficulty="hard",
                           expected_input_tokens=in_tokens, expected_output_tokens=50),
            constraints=Constraints(candidate_models=["m"]),
            cost_quality_tradeoff=0.0, allow_llm_escalation=False,
        )

    resp = await engine.recommend(_req(100))
    rec = resp.recommended_model
    # request input (100) priced + observed output (2000, not the 50 asked) priced
    expected = 100 / 1e6 * 2.0 + 2000 / 1e6 * 10.0
    assert rec.est_cost_usd == pytest.approx(expected, abs=1e-9)
    assert rec.est_cost_breakdown["obs_output_tokens"] == pytest.approx(2000)
    # request-size sensitive: a larger input prompt costs more (the residual the rescale fixes)
    bigger = await engine.recommend(_req(10_000))
    assert bigger.recommended_model.est_cost_usd > rec.est_cost_usd
