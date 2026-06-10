"""Shared test doubles and builders."""

from __future__ import annotations

from typing import Any

from minima.llm.base import CandidateView, ReasonerRanking, ReasonerResult
from minima.memory.records import OutcomeRecord, RecalledEvidence, RecallResult
from minima.schemas.common import Difficulty, TaskType


class FakeMemory:
    """In-memory stand-in for MubitMemory; records every write for assertions."""

    def __init__(
        self,
        evidence: list[RecalledEvidence] | None = None,
        *,
        strategies: list[dict[str, Any]] | None = None,
    ):
        self.evidence = list(evidence or [])
        self.remembered: list[dict[str, Any]] = []
        self.outcomes: list[dict[str, Any]] = []
        self.lessons: list[dict[str, Any]] = []
        self.batches: list[tuple[str, list[dict]]] = []
        self.reflects: list[dict[str, Any]] = []
        self._strategies = list(strategies or [])
        self.next_record_id = "rec-fake-1"

    async def recall(self, **_kwargs: Any) -> RecallResult:
        return RecallResult(evidence=list(self.evidence))

    async def remember_outcome(self, **kwargs: Any) -> str | None:
        self.remembered.append(kwargs)
        return self.next_record_id

    async def record_outcome(self, **kwargs: Any) -> dict:
        self.outcomes.append(kwargs)
        return {"updated_confidence": 0.71, "reinforcement_count": 1, "success": True}

    async def remember_lesson(self, **kwargs: Any) -> str | None:
        self.lessons.append(kwargs)
        return "lesson-fake-1"

    async def batch_insert(
        self, *, run_id: str, items: list[dict], deduplicate: bool = True
    ) -> dict:
        self.batches.append((run_id, items))
        return {"count": len(items), "success": True}

    async def get_context(self, **_kwargs: Any) -> str:
        return ""

    async def reflect(self, **kwargs: Any) -> dict:
        self.reflects.append(kwargs)
        return {"success": True}

    async def surface_strategies(self, **_kwargs: Any) -> dict:
        return {"strategies": list(self._strategies)}

    async def health(self) -> dict:
        return {"reachable": True, "transport": "fake"}


class FakeReasoner:
    """Records calls; returns canned rankings/classification (or None to simulate failure)."""

    def __init__(
        self,
        rankings: list[tuple[str, float, str]] | None = None,
        *,
        recommended: str | None = None,
        fallback: str | None = None,
        classify_result: tuple[TaskType, Difficulty] | None = None,
        fail: bool = False,
    ):
        self._rankings = rankings or []
        self._recommended = recommended
        self._fallback = fallback
        self._classify_result = classify_result
        self._fail = fail
        self.rank_calls: list[dict[str, Any]] = []
        self.classify_calls: list[str] = []

    async def rank(
        self,
        *,
        task: str,
        task_type: str,
        difficulty: str,
        candidates: list[CandidateView],
        memory_block: str,
        cost_quality_tradeoff: float,
    ) -> ReasonerResult | None:
        self.rank_calls.append(
            {"task_type": task_type, "candidates": [c.model_id for c in candidates]}
        )
        if self._fail:
            return None
        return ReasonerResult(
            rankings=[ReasonerRanking(m, p, r) for (m, p, r) in self._rankings],
            recommended=self._recommended,
            fallback=self._fallback,
        )

    async def classify(self, *, task: str) -> tuple[TaskType, Difficulty] | None:
        self.classify_calls.append(task)
        return self._classify_result


def make_evidence(
    model_id: str,
    quality: float,
    *,
    entry_id: str,
    reference_id: str | None = None,
    score: float = 0.85,
    knowledge_confidence: float = 0.7,
    is_stale: bool = False,
    task_type: str = "code",
    difficulty: str = "hard",
    cost_usd: float = 0.0,
    input_tokens: int = 0,
    output_tokens: int = 0,
) -> RecalledEvidence:
    record = OutcomeRecord(
        model_id=model_id,
        task_type=task_type,
        difficulty=difficulty,
        task_cluster=f"{task_type}:{difficulty}",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        quality_score=quality,
        outcome="success" if quality >= 0.5 else "failure",
        cost_usd=cost_usd,
    )
    return RecalledEvidence(
        entry_id=entry_id,
        reference_id=reference_id,
        score=score,
        knowledge_confidence=knowledge_confidence,
        is_stale=is_stale,
        content="prior task",
        record=record,
    )
