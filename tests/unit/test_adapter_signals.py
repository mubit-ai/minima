"""Free signals on the Mubit wire: drift flags, supersession, and the dereference budget."""

from __future__ import annotations

import time

from minima.config import Settings
from minima.memory.adapter import MubitMemory, _parse_evidence


def _memory(**settings_overrides) -> MubitMemory:
    return MubitMemory(Settings(mubit_api_key="t", **settings_overrides))


def _evidence_item(**extra) -> dict:
    return {
        "id": "e-1",
        "score": 0.8,
        "knowledge_confidence": 0.7,
        "content": "gist",
        "metadata_json": None,
        **extra,
    }


def test_parse_recall_reads_drift_signals():
    result = _memory()._parse_recall(
        {
            "evidence": [],
            "signals": {
                "repeated": True,
                "stagnant": True,
                "drift_score": 0.62,
                "novelty_score": 0.1,
            },
        }
    )
    assert result.drift_repeated is True
    assert result.drift_stagnant is True
    assert result.drift_score == 0.62
    assert result.novelty_score == 0.1


def test_parse_recall_without_signals_defaults_to_no_signal():
    result = _memory()._parse_recall({"evidence": []})
    assert result.drift_repeated is False
    assert result.drift_stagnant is False
    assert result.drift_score == -1.0
    assert result.novelty_score == -1.0


def test_superseded_evidence_is_stale_even_when_flag_lags():
    ev = _parse_evidence(_evidence_item(is_stale=False, superseded_by="e-9"))
    assert ev.superseded_by == "e-9"
    assert ev.is_stale is True


def test_unsuperseded_evidence_keeps_reported_staleness():
    assert _parse_evidence(_evidence_item(is_stale=False)).is_stale is False
    assert _parse_evidence(_evidence_item(is_stale=True)).is_stale is True
    assert _parse_evidence(_evidence_item(superseded_by="")).superseded_by is None


async def test_dereference_shares_the_recall_budget():
    """A hung Mubit must cost the recall budget, not the 30s client timeout."""
    memory = _memory(minima_memory_recall_timeout_ms=50)

    class _HangingClient:
        def dereference(self, *, reference_id, session_id):
            time.sleep(5)
            return {"found": True, "evidence": {"id": reference_id}}

    memory._client = _HangingClient()
    start = time.monotonic()
    result = await memory.dereference(lane="minima:t", reference_id="ref-1")
    elapsed = time.monotonic() - start
    assert result is None
    assert elapsed < 2.0
