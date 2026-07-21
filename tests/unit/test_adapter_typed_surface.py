"""mubit-sdk 0.13.0 typed-surface adoption: recall knobs, occurrence_time, idempotency."""

from __future__ import annotations

import time
from typing import Any

from minima.config import Settings
from minima.memory.adapter import MubitMemory
from minima.memory.records import OutcomeRecord


class _CapturingClient:
    def __init__(self, recall_response: dict | None = None):
        self.recall_calls: list[dict[str, Any]] = []
        self.remember_calls: list[dict[str, Any]] = []
        self.outcome_calls: list[dict[str, Any]] = []
        self._recall_response = recall_response or {"evidence": []}

    def recall(self, **kwargs: Any) -> dict:
        self.recall_calls.append(kwargs)
        return self._recall_response

    def remember(self, **kwargs: Any) -> dict:
        self.remember_calls.append(kwargs)
        return {"traces": [{"writes": [{"record_id": "rec-1"}]}]}

    def record_outcome(self, **kwargs: Any) -> dict:
        self.outcome_calls.append(kwargs)
        return {"updated_confidence": 0.7}


def _memory(client: _CapturingClient, **settings_overrides) -> MubitMemory:
    memory = MubitMemory(Settings(mubit_api_key="t", **settings_overrides))
    memory._client = client
    return memory


def _record() -> OutcomeRecord:
    return OutcomeRecord(
        model_id="claude-haiku-4-5",
        provider="anthropic",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        outcome="success",
        quality_score=0.9,
        evidence_source="judge",
        recorded_at=1_752_000_000.5,
    )


async def test_recall_uses_typed_client_with_configured_knobs():
    client = _CapturingClient()
    memory = _memory(client)
    await memory.recall(query="[code/hard] gist", lane="minima:t")
    call = client.recall_calls[0]
    assert call["session_id"] == "minima:t"
    assert call["lane"] == "minima:t"
    assert call["evidence_only"] is True
    assert call["prefer_current_run"] is True
    assert call["rank_by"] == "balanced"
    assert call["budget"] == "mid"
    assert call["explain"] is False


async def test_explain_sampling_full_rate_requests_breakdown():
    client = _CapturingClient(
        recall_response={
            "evidence": [
                {
                    "id": "e-1",
                    "score": 0.8,
                    "explain_info": {"semantic_score": 0.9, "recency_score": 0.4},
                }
            ]
        }
    )
    memory = _memory(client, minima_recall_explain_sample=1.0)
    result = await memory.recall(query="q", lane="minima:t")
    assert client.recall_calls[0]["explain"] is True
    assert len(result.evidence) == 1


async def test_explain_sampling_off_by_default():
    client = _CapturingClient()
    memory = _memory(client)
    await memory.recall(query="q", lane="minima:t")
    assert client.recall_calls[0]["explain"] is False


async def test_remember_outcome_carries_occurrence_time():
    client = _CapturingClient()
    memory = _memory(client)
    record = _record()
    await memory.remember_outcome(
        content="[code/hard] gist",
        record=record,
        lane="minima:t",
        upsert_key="minima:om:code:hard:claude-haiku-4-5",
        idempotency_key="oc:abc",
    )
    call = client.remember_calls[0]
    assert call["occurrence_time"] == int(record.recorded_at)


async def test_remember_outcome_without_recorded_at_omits_occurrence_time():
    client = _CapturingClient()
    memory = _memory(client)
    record = _record()
    record.recorded_at = None
    await memory.remember_outcome(
        content="c",
        record=record,
        lane="minima:t",
        upsert_key="k",
        idempotency_key="i",
    )
    assert client.remember_calls[0]["occurrence_time"] is None


async def test_record_outcome_uses_typed_wrapper_with_idempotency():
    client = _CapturingClient()
    memory = _memory(client)
    await memory.record_outcome(
        lane="minima:t",
        reference_id="ref-1",
        outcome="success",
        signal=0.8,
        idempotency_key="oc:xyz",
        verified_in_production=True,
    )
    call = client.outcome_calls[0]
    assert call["session_id"] == "minima:t"
    assert call["idempotency_key"] == "oc:xyz"
    assert call["verified_in_production"] is True


async def test_recall_min_timestamp_window():
    client = _CapturingClient()
    memory = _memory(client, minima_recall_max_age_days=7)
    before = time.time()
    await memory.recall(query="q", lane="minima:t")
    min_ts = client.recall_calls[0]["min_timestamp"]
    assert min_ts is not None
    assert abs(min_ts - (before - 7 * 86_400)) < 5
