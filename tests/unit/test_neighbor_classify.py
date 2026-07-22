"""Tests for neighbor-vote task classification (disambiguating `other` from recall)."""

from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.classify import classify_details, classify_from_neighbors, infer_task_type
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Difficulty, TaskInput, TaskType
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence

_AMBIGUOUS = "Arrange the colored blocks by their texture and weight"
# Heuristic says qa (leading interrogative) but with confidence under the 0.6 gate.
_LOW_CONFIDENCE = "Can the flaky deploys be sorted out soon?"

_CODE_VOTES = [
    make_evidence("gemini-2.5-flash", 0.9, entry_id="e1", task_type="code"),
    make_evidence("gemini-2.5-flash", 0.85, entry_id="e2", task_type="code"),
]


def _engine(memory: FakeMemory) -> Recommender:
    settings = Settings(mubit_api_key="t")
    return Recommender(settings, memory, CatalogStore(settings), RecommendationStore())


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


def test_classify_details_uses_neighbor_votes():
    details = classify_details(
        TaskInput(task=_AMBIGUOUS),
        neighbor_votes=[("code", 0.9), ("code", 0.8), ("qa", 0.2)],
    )
    assert details.task_type == TaskType.code
    assert details.features.code > 0
    assert details.features.reasoning > 0
    assert details.neighbor_support > 0
    assert details.neighbor_count == 2
    assert 0.0 <= details.uncertainty <= 1.0


def test_classify_details_neighbor_votes_reinfer_difficulty():
    baseline = classify_details(TaskInput(task=_AMBIGUOUS))
    assert (baseline.task_type, baseline.difficulty) == (TaskType.other, Difficulty.easy)
    details = classify_details(
        TaskInput(task=_AMBIGUOUS), neighbor_votes=[("code", 0.9), ("code", 0.8)]
    )
    assert details.task_type == TaskType.code
    assert details.difficulty == Difficulty.medium  # re-inferred with the code +1 shift


def test_classify_details_caller_difficulty_survives_neighbor_votes():
    details = classify_details(
        TaskInput(task=_AMBIGUOUS, difficulty=Difficulty.expert),
        neighbor_votes=[("code", 0.9), ("code", 0.8)],
    )
    assert details.task_type == TaskType.code
    assert details.difficulty == Difficulty.expert


async def test_engine_refines_other_from_neighbors():
    resp = await _engine(FakeMemory(_CODE_VOTES)).recommend(
        RecommendRequest(task=TaskInput(task=_AMBIGUOUS), allow_llm_escalation=False)
    )
    assert resp.classified_task_type == TaskType.code
    assert resp.classified_difficulty == Difficulty.medium  # was easy under type-only rewrite
    assert "neighbor_classified" in resp.warnings


async def test_engine_refines_low_confidence_type_from_neighbors():
    resp = await _engine(FakeMemory(_CODE_VOTES)).recommend(
        RecommendRequest(task=TaskInput(task=_LOW_CONFIDENCE), allow_llm_escalation=False)
    )
    assert resp.classified_task_type == TaskType.code
    assert "neighbor_classified" in resp.warnings


async def test_engine_keeps_confident_heuristic_despite_neighbors():
    resp = await _engine(FakeMemory(_CODE_VOTES)).recommend(
        RecommendRequest(
            task=TaskInput(task="Summarize this article in three sentences."),
            allow_llm_escalation=False,
        )
    )
    assert resp.classified_task_type == TaskType.summarization
    assert "neighbor_classified" not in resp.warnings


async def test_engine_never_refines_caller_type():
    resp = await _engine(FakeMemory(_CODE_VOTES)).recommend(
        RecommendRequest(
            task=TaskInput(task=_AMBIGUOUS, task_type=TaskType.qa), allow_llm_escalation=False
        )
    )
    assert resp.classified_task_type == TaskType.qa
    assert "neighbor_classified" not in resp.warnings


async def test_engine_keeps_other_without_neighbors():
    resp = await _engine(FakeMemory()).recommend(
        RecommendRequest(task=TaskInput(task=_AMBIGUOUS), allow_llm_escalation=False)
    )
    assert resp.classified_task_type == TaskType.other
    assert "neighbor_classified" not in resp.warnings


async def test_engine_confidence_gate_configurable():
    settings = Settings(mubit_api_key="t", minima_neighbor_classify_confidence=0.0)
    engine = Recommender(
        settings, FakeMemory(_CODE_VOTES), CatalogStore(settings), RecommendationStore()
    )
    resp = await engine.recommend(
        RecommendRequest(task=TaskInput(task=_LOW_CONFIDENCE), allow_llm_escalation=False)
    )
    # Gate at 0.0 -> only `other` refines; the low-confidence qa heuristic stands.
    assert resp.classified_task_type == TaskType.qa
    assert "neighbor_classified" not in resp.warnings
