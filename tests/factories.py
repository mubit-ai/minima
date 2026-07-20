"""Shared test doubles and builders."""

from __future__ import annotations

from typing import Any

from minima.memory.records import OutcomeRecord, RecalledEvidence, RecallResult


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
        self.recall_calls: list[dict[str, Any]] = []
        self.lookup_calls: list[dict[str, Any]] = []
        self.dereference_calls: list[dict[str, Any]] = []
        self.deref_results: dict[str, RecalledEvidence] = {}
        self.lookup_results: list[RecalledEvidence] = []
        self._strategies = list(strategies or [])
        self.next_record_id = "rec-fake-1"
        self.get_context_calls: list[dict[str, Any]] = []

    async def recall(self, **kwargs: Any) -> RecallResult:
        self.recall_calls.append(kwargs)
        return RecallResult(evidence=list(self.evidence))

    async def lookup(
        self, *, lane: str, match: list[dict], limit: int = 256
    ) -> list[RecalledEvidence] | None:
        self.lookup_calls.append({"lane": lane, "match": match})
        if self.lookup_results is None:  # simulate a degraded keyed channel
            return None
        return list(self.lookup_results)

    async def dereference(self, *, lane: str, reference_id: str) -> RecalledEvidence | None:
        self.dereference_calls.append({"lane": lane, "reference_id": reference_id})
        return self.deref_results.get(reference_id)

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
        self.get_context_calls.append(_kwargs)
        return ""

    async def reflect(self, **kwargs: Any) -> dict:
        self.reflects.append(kwargs)
        return {"success": True}

    async def surface_strategies(self, **_kwargs: Any) -> dict:
        return {"strategies": list(self._strategies)}

    async def health(self) -> dict:
        return {"reachable": True, "transport": "fake"}



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
    latency_ms: int | None = None,
    recorded_at: float | None = None,
    source_dataset: str | None = None,
    referenceable: bool = False,
    evidence_source: str | None = None,
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
        evidence_source=evidence_source or ("dataset" if source_dataset else "judge"),
        cost_usd=cost_usd,
        latency_ms=latency_ms,
        recorded_at=recorded_at,
        source_dataset=source_dataset,
    )
    return RecalledEvidence(
        entry_id=entry_id,
        reference_id=reference_id,
        score=score,
        knowledge_confidence=knowledge_confidence,
        is_stale=is_stale,
        content="prior task",
        record=record,
        referenceable=referenceable,
    )
