from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender import escalation
from minima.recommender.engine import Recommender
from minima.recommender.escalation import EscalationDecision
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, DecisionBasis, TaskInput, TaskType
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, FakeReasoner

CODE_TASK = TaskInput(task="refactor a recursive def foo()", task_type="code", difficulty="hard")
CANDIDATES = Constraints(candidate_models=["claude-haiku-4-5", "claude-opus-4-8", "gpt-4o-mini"])


def _engine(reasoner, memory=None, settings=None) -> Recommender:
    settings = settings or Settings(mubit_api_key="t", minima_reasoner_provider="anthropic")
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


async def test_fast_reasoner_trims_memory_and_candidates():
    reasoner = FakeReasoner(
        rankings=[
            ("claude-haiku-4-5", 0.95, "handles this fine"),
            ("claude-opus-4-8", 0.9, "overkill"),
            ("gpt-4o-mini", 0.5, "too weak"),
        ]
    )
    memory = FakeMemory()
    settings = Settings(
        mubit_api_key="t",
        minima_reasoner_provider="anthropic",
        minima_reasoner_fast_mode=True,
        minima_reasoner_fast_memory_token_budget=321,
        minima_reasoner_fast_candidate_limit=2,
    )
    engine = Recommender(
        settings,
        memory,
        CatalogStore(settings),
        RecommendationStore(),
        reasoner=reasoner,
    )
    resp = await engine.recommend(RecommendRequest(task=CODE_TASK, constraints=CANDIDATES))

    assert reasoner.rank_calls
    assert len(reasoner.rank_calls[0]["candidates"]) == 2
    assert memory.get_context_calls[0]["max_token_budget"] == 321
    assert resp.decision_basis == DecisionBasis.llm


async def test_fast_reasoner_can_skip_low_value_escalation(monkeypatch):
    reasoner = FakeReasoner(rankings=[("claude-haiku-4-5", 0.95, "handles this fine")])
    engine = _engine(
        reasoner,
        settings=Settings(
            mubit_api_key="t",
            minima_reasoner_provider="anthropic",
            minima_reasoner_fast_mode=True,
            minima_reasoner_fast_skip_low_value=True,
            anthropic_api_key="sk-test",
        ),
    )

    monkeypatch.setattr(escalation, "evaluate", lambda **_kwargs: EscalationDecision(True, ["tie"]))

    resp = await engine.recommend(RecommendRequest(task=CODE_TASK, constraints=CANDIDATES))

    assert reasoner.rank_calls == []
    assert "reasoner_skipped_low_value" in resp.warnings
    assert resp.decision_basis == DecisionBasis.prior


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


async def test_reasoner_does_not_refine_classification():
    reasoner = FakeReasoner()
    engine = _engine(reasoner)
    # No keywords -> heuristic classifies as "other"; no caller task_type hint.
    resp = await engine.recommend(
        RecommendRequest(task=TaskInput(task="zzz qqq random tokens nothing matches"))
    )
    assert reasoner.classify_calls == []
    assert resp.classified_task_type == TaskType.other


async def test_confident_summarization_skips_reasoner():
    reasoner = FakeReasoner(
        rankings=[
            ("claude-haiku-4-5", 0.95, "handles this fine"),
            ("claude-opus-4-8", 0.9, "overkill"),
        ]
    )
    engine = _engine(reasoner)
    resp = await engine.recommend(
        RecommendRequest(
            task=TaskInput(
                task="Summarize this incident report into 3 bullets.",
                task_type="summarization",
            ),
            cost_quality_tradeoff=3,
        )
    )
    assert reasoner.rank_calls == []
    assert resp.classification_profile.confidence >= 0.75
    assert resp.classification_profile.easy_route is True
    assert resp.decision_basis == DecisionBasis.prior
