"""MINIMA_POSTERIOR_DISCOUNTING gate: discounted+reset posteriors are opt-in.

Flag off (the default), the live pick is identical to the undiscounted recommender —
aged or pre-reset evidence still counts in full (floored decay only); the discount and
reset epochs run shadow-only. Flag on, the unfloored discount forgets a dead regime and
reset epochs zero pre-epoch records.
"""

from __future__ import annotations

import time

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.recommender.resets import CAUSE_SNAPSHOT_CHANGE, ResetRegistry
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence

# Classifies code:hard; gemini-2.5-flash is the cheapest candidate that scrapes past tau
# on its catalog prior — one labeled failure removes it, next-cheapest eligible wins.
_BAKERY = "build me a website for my bakery"

# Pinned candidate pool: catalog growth must not move the borderline these tests sit on.
_POOL = [
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

_ANCIENT = time.time() - 400 * 86_400.0


def _settings(**overrides) -> Settings:
    return Settings(mubit_api_key="t", minima_selection_policy="argmin", **overrides)


def _aged_failure() -> FakeMemory:
    return FakeMemory(
        [make_evidence("gemini-2.5-flash", 0.1, entry_id="e1", recorded_at=_ANCIENT)]
    )


async def _recommend(
    settings: Settings, memory: FakeMemory, resets: ResetRegistry | None = None
):
    engine = Recommender(
        settings, memory, CatalogStore(settings), RecommendationStore(), resets=resets
    )
    return await engine.recommend(
        RecommendRequest(
            task=TaskInput(task=_BAKERY),
            constraints=Constraints(candidate_models=_POOL),
            allow_llm_escalation=False,
        )
    )


def test_flag_defaults_off():
    assert _settings().minima_posterior_discounting is False


async def test_default_off_keeps_aged_failure_decisive():
    # Pre-gate behavior: the 400-day-old failure still votes at full (floored-decay)
    # weight, so flash stays excluded — the recommendation is unchanged by shipping
    # the discount machinery.
    resp = await _recommend(_settings(), _aged_failure())
    assert resp.recommended_model.model_id == "gemini-3-flash-preview"


async def test_flag_on_forgets_the_dead_regime():
    resp = await _recommend(
        _settings(minima_posterior_discounting=True, minima_aggregate_half_life_days=1.0),
        _aged_failure(),
    )
    assert resp.recommended_model.model_id == "gemini-2.5-flash"


async def test_flag_on_with_zero_half_life_keeps_legacy_weighting():
    resp = await _recommend(
        _settings(minima_posterior_discounting=True, minima_aggregate_half_life_days=0.0),
        _aged_failure(),
    )
    assert resp.recommended_model.model_id == "gemini-3-flash-preview"


async def test_reset_epoch_only_applies_behind_the_flag():
    resets = ResetRegistry()
    memory = FakeMemory(
        [
            make_evidence(
                "gemini-2.5-flash", 0.95, entry_id="e1", recorded_at=time.time() - 3_600.0
            )
        ]
    )
    resets.stamp("gemini-2.5-flash", cause=CAUSE_SNAPSHOT_CHANGE)

    off = await _recommend(_settings(), memory, resets=resets)
    assert off.recommended_model.model_id == "gemini-2.5-flash"

    on = await _recommend(_settings(minima_posterior_discounting=True), memory, resets=resets)
    assert on.recommended_model.model_id == "gemini-3-flash-preview"
    assert "cold_start_margin_applied" in on.warnings
