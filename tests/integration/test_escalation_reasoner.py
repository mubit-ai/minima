from __future__ import annotations

from costit.catalog.store import CatalogStore
from costit.config import Settings
from costit.recommender.engine import Recommender
from costit.recommender.recstore import RecommendationStore
from costit.schemas.common import Constraints, DecisionBasis, Difficulty, TaskInput, TaskType
from costit.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, FakeReasoner

CODE_TASK = TaskInput(task="refactor a recursive def foo()", task_type="code", difficulty="hard")
CANDIDATES = Constraints(candidate_models=["claude-haiku-4-5", "claude-opus-4-8", "gpt-4o-mini"])


def _engine(reasoner, memory=None, settings=None) -> Recommender:
    settings = settings or Settings(mubit_api_key="t", costit_reasoner_provider="anthropic")
    return Recommender(
        settings,
        memory or FakeMemory(),
        CatalogStore(settings),
        RecommendationStore(),
        reasoner=reasoner,
    )


async def test_thin_evidence_escalates_and_blends():
    # Reasoner pushes the cheap model above threshold; deterministic cold-start would pick Opus.
    reasoner = FakeReasoner(
        rankings=[
            ("claude-haiku-4-5", 0.95, "handles this fine"),
            ("claude-opus-4-8", 0.9, "overkill"),
            ("gpt-4o-mini", 0.5, "too weak"),
        ]
    )
    engine = _engine(reasoner)
    resp = await engine.recommend(RecommendRequest(task=CODE_TASK, constraints=CANDIDATES))

    assert reasoner.rank_calls, "reasoner should have been consulted on thin evidence"
    assert resp.decision_basis == DecisionBasis.llm
    assert resp.recommended_model.model_id == "claude-haiku-4-5"
    assert "reasoner_consulted" in resp.warnings
    assert any(w.startswith("escalation_suggested:") for w in resp.warnings)


async def test_reasoner_failure_degrades_gracefully():
    engine = _engine(FakeReasoner(fail=True))
    resp = await engine.recommend(RecommendRequest(task=CODE_TASK, constraints=CANDIDATES))
    assert "reasoner_failed" in resp.warnings
    # Falls back to the deterministic prior-only pick (Opus clears the bar at cold start).
    assert resp.decision_basis == DecisionBasis.prior
    assert resp.recommended_model.model_id == "claude-opus-4-8"


async def test_no_reasoner_reports_disabled():
    settings = Settings(mubit_api_key="t")  # provider none
    engine = Recommender(settings, FakeMemory(), CatalogStore(settings), RecommendationStore())
    resp = await engine.recommend(RecommendRequest(task=CODE_TASK, constraints=CANDIDATES))
    assert "reasoner_disabled" in resp.warnings


async def test_llm_classification_refines_ambiguous_task():
    reasoner = FakeReasoner(classify_result=(TaskType.code, Difficulty.hard))
    engine = _engine(reasoner)
    # No keywords -> heuristic classifies as "other"; no caller task_type hint.
    resp = await engine.recommend(
        RecommendRequest(task=TaskInput(task="zzz qqq random tokens nothing matches"))
    )
    assert reasoner.classify_calls
    assert resp.classified_task_type == TaskType.code
    assert resp.classified_difficulty == Difficulty.hard
    assert "llm_classified" in resp.warnings
