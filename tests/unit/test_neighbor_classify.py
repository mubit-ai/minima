"""Tests for neighbor-vote task classification (disambiguating `other` from recall)."""

from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.classify import classify_from_neighbors, infer_task_type
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import TaskInput, TaskType
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence

_AMBIGUOUS = "Arrange the colored blocks by their texture and weight"


def test_infer_is_other_for_ambiguous_text():
    assert infer_task_type(_AMBIGUOUS) == TaskType.other


def test_neighbor_vote_picks_plurality():
    votes = [("code", 0.9), ("code", 0.8), ("qa", 0.3)]
    assert classify_from_neighbors(votes) == TaskType.code


def test_neighbor_vote_needs_min_support():
    assert classify_from_neighbors([("code", 0.9)]) is None  # only one neighbor
    assert classify_from_neighbors([]) is None
    # 'other' votes are ignored
    assert classify_from_neighbors([("other", 0.9), ("other", 0.9)]) is None


def test_neighbor_vote_needs_majority_share():
    # split 3 ways with no >=50% winner -> abstain
    votes = [("code", 0.3), ("qa", 0.3), ("reasoning", 0.3)]
    assert classify_from_neighbors(votes, min_neighbors=1) is None


async def test_engine_refines_other_from_neighbors():
    evidence = [
        make_evidence("gemini-2.5-flash", 0.9, entry_id="e1", task_type="code"),
        make_evidence("gemini-2.5-flash", 0.85, entry_id="e2", task_type="code"),
    ]
    settings = Settings(mubit_api_key="t")
    engine = Recommender(
        settings, FakeMemory(evidence), CatalogStore(settings), RecommendationStore()
    )
    resp = await engine.recommend(
        RecommendRequest(task=TaskInput(task=_AMBIGUOUS), allow_llm_escalation=False)
    )
    assert resp.classified_task_type == TaskType.code
    assert "neighbor_classified" in resp.warnings


async def test_engine_keeps_other_without_neighbors():
    settings = Settings(mubit_api_key="t")
    engine = Recommender(settings, FakeMemory(), CatalogStore(settings), RecommendationStore())
    resp = await engine.recommend(
        RecommendRequest(task=TaskInput(task=_AMBIGUOUS), allow_llm_escalation=False)
    )
    assert resp.classified_task_type == TaskType.other
    assert "neighbor_classified" not in resp.warnings
