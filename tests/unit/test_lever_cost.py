"""Tests for lever-aware (cache-blended) cost and the recommended-actions bundle."""

from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender import score
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import TaskInput
from minima.schemas.models_catalog import ModelCard
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory


def test_estimate_cost_cache_blend():
    card = ModelCard(
        model_id="m",
        provider="p",
        input_cost_per_mtok=10.0,
        output_cost_per_mtok=0.0,
        cache_read_cost_per_mtok=1.0,
        supports_prompt_caching=True,
    )
    full, _ = score.estimate_cost(card, 1_000_000, 0)
    blended, _ = score.estimate_cost(card, 1_000_000, 0, cache_fraction=0.5)
    assert full == 10.0
    assert blended == 5.5  # 0.5 * 1.0 + 0.5 * 10.0


def test_cache_blend_noop_without_cache_price():
    card = ModelCard(model_id="m", provider="p", input_cost_per_mtok=10.0, output_cost_per_mtok=0.0)
    full, _ = score.estimate_cost(card, 1_000_000, 0)
    blended, _ = score.estimate_cost(card, 1_000_000, 0, cache_fraction=0.5)
    assert full == blended == 10.0  # no cache_read price -> blend is a no-op


def _engine(settings: Settings) -> Recommender:
    return Recommender(settings, FakeMemory(), CatalogStore(settings), RecommendationStore())


_REQ = RecommendRequest(
    task=TaskInput(task="write a python function", task_type="code"), allow_llm_escalation=False
)


async def test_recommended_actions_consistent_with_caching_support():
    resp = await _engine(Settings(mubit_api_key="t")).recommend(_REQ)
    if resp.recommended_model.supports_prompt_caching:
        assert "enable_prompt_cache" in resp.recommended_actions
    else:
        assert "enable_prompt_cache" not in resp.recommended_actions


async def test_lever_aware_lowers_cache_model_estimates():
    off = await _engine(Settings(mubit_api_key="t")).recommend(_REQ)
    on = await _engine(
        Settings(mubit_api_key="t", minima_cost_lever_aware=True)
    ).recommend(_REQ)
    off_by = {m.model_id: m for m in off.ranked}
    lowered = 0
    for m in on.ranked:
        o = off_by[m.model_id]
        assert m.est_cost_usd <= o.est_cost_usd + 1e-9  # lever-aware never raises cost
        if m.supports_prompt_caching and m.est_cost_usd < o.est_cost_usd - 1e-12:
            lowered += 1
    assert lowered > 0  # at least one cache-supporting model got cheaper at cold start
