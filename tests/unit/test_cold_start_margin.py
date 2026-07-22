"""Cold-start eligibility margin: pure-prior candidates must clear tau + margin."""

from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence

# Classifies code:hard (Phase 0); gemini-2.5-flash's 0.74 code prior scrapes past the
# default tau of 0.735 by 0.005 — exactly the borderline the margin exists for.
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


def _settings(**overrides) -> Settings:
    return Settings(mubit_api_key="t", minima_selection_policy="argmin", **overrides)


async def _recommend(settings: Settings, memory: FakeMemory):
    engine = Recommender(settings, memory, CatalogStore(settings), RecommendationStore())
    return await engine.recommend(
        RecommendRequest(
            task=TaskInput(task=_BAKERY),
            constraints=Constraints(candidate_models=_POOL),
            allow_llm_escalation=False,
        )
    )


async def test_default_margin_moves_cold_start_off_the_borderline_prior():
    resp = await _recommend(_settings(), FakeMemory())
    assert "cold_start" in resp.warnings
    assert "cold_start_margin_applied" in resp.warnings
    assert resp.recommended_model.model_id != "gemini-2.5-flash"
    assert resp.recommended_model.model_id == "gemini-3-flash-preview"


async def test_margin_zero_restores_borderline_pick():
    resp = await _recommend(_settings(minima_cold_start_margin=0.0), FakeMemory())
    assert resp.recommended_model.model_id == "gemini-2.5-flash"
    assert "cold_start_margin_applied" not in resp.warnings


async def test_margin_never_empties_the_eligible_set():
    resp = await _recommend(_settings(minima_cold_start_margin=0.5), FakeMemory())
    # Nothing clears tau + 0.5, so plain tau applies — same pick as margin 0, no 422.
    assert resp.recommended_model.model_id == "gemini-2.5-flash"
    assert "cold_start_margin_applied" not in resp.warnings


async def test_evidence_backed_candidate_is_exempt_from_margin():
    evidence = [make_evidence("gemini-2.5-flash", 0.95, entry_id="e1")]
    resp = await _recommend(_settings(), FakeMemory(evidence))
    assert resp.recommended_model.model_id == "gemini-2.5-flash"
    assert "cold_start_margin_applied" not in resp.warnings


async def test_single_labeled_failure_still_dominates():
    evidence = [make_evidence("gemini-2.5-flash", 0.1, entry_id="e1")]
    resp = await _recommend(_settings(), FakeMemory(evidence))
    # The failure record (not the margin) removes flash; next-cheapest eligible wins.
    assert resp.recommended_model.model_id == "gemini-3-flash-preview"
    assert "cold_start_margin_applied" not in resp.warnings
