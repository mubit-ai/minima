"""Live coverage for the Phase-1 recall params against a real Mubit runtime.

Exercises the low-level control query path (entry_types / rank_by / budget /
min_timestamp / explain), the recorded_at (schema v2) round-trip, and the
dereference exact re-read.

Run with a Mubit runtime up (e.g. `make run-mubit` in the Mubit repo) and:
    MUBIT_ENDPOINT=http://127.0.0.1:3000 MUBIT_API_KEY=... MUBIT_TRANSPORT=http \
    uv run pytest -m live -k recall_params -q
"""

from __future__ import annotations

import os
import time
import uuid

import pytest

from minima.config import Settings
from minima.memory import threadpool
from minima.memory.adapter import MubitMemory
from minima.memory.keys import build_content, outcome_upsert_key, task_cluster, task_fingerprint
from minima.memory.records import OutcomeRecord, RecallResult

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"
    ),
]

# The local CPU embedder is slow and variable; production default (2500ms) targets a
# fast GPU embedder.
RECALL_TIMEOUT_MS = 8000

TASK = (
    "Design a rate limiter for a multi-tenant API gateway using a sliding window "
    "log with burst allowance and per-tenant quota overrides"
)
MODEL_ID = "claude-haiku-4-5"


def _ns() -> str:
    return f"livetest-params-{uuid.uuid4().hex[:8]}"


def _base_settings(**overrides) -> Settings:
    base: dict = {
        "minima_memory_recall_timeout_ms": RECALL_TIMEOUT_MS,
        "minima_reflect_every_n": 0,
    }
    base.update(overrides)
    return Settings(**base)


async def _write_outcome(
    memory: MubitMemory, lane: str
) -> tuple[str, OutcomeRecord]:
    """Write one outcome the way the feedback path does (recorded_at stamped now)."""
    cluster = task_cluster("code", "hard")
    record = OutcomeRecord(
        model_id=MODEL_ID,
        task_type="code",
        difficulty="hard",
        task_fingerprint=task_fingerprint(TASK),
        task_cluster=cluster,
        quality_score=0.92,
        outcome="success",
        recorded_at=time.time(),
    )
    record_id = await memory.remember_outcome(
        content=build_content("code", "hard", TASK),
        record=record,
        lane=lane,
        upsert_key=outcome_upsert_key(cluster, MODEL_ID),
        idempotency_key=f"params-live-{uuid.uuid4().hex[:8]}",
        source="human",
    )
    assert record_id, "remember_outcome must return a record id"
    return record_id, record


async def _recall_until_model(
    memory: MubitMemory, *, lane: str, model_id: str, attempts: int = 8
) -> RecallResult:
    """Recall is eventually-consistent after ingest (server embeds on insert)."""
    result = RecallResult(evidence=[])
    for _ in range(attempts):
        result = await memory.recall(
            query=TASK, lane=lane, limit=25, timeout_ms=RECALL_TIMEOUT_MS
        )
        if any(
            e.record is not None and e.record.model_id == model_id
            for e in result.outcome_evidence
        ):
            return result
        time.sleep(1.0)
    return result


# --------------------------------------------------------------------------------------
# 1+2. recall with the new default payload (entry_types/rank_by/budget) + recorded_at
# --------------------------------------------------------------------------------------
async def test_recall_new_defaults_and_recorded_at_roundtrip_live():
    settings = _base_settings()
    memory = MubitMemory(settings)
    lane = settings.lane(_ns())

    _record_id, written = await _write_outcome(memory, lane)

    recall = await _recall_until_model(memory, lane=lane, model_id=MODEL_ID)
    # The new payload fields (entry_types=["fact","observation"], rank_by="balanced",
    # budget="mid") must not error out the query.
    assert recall.error is None
    assert recall.timed_out is False

    matches = [
        e for e in recall.outcome_evidence if e.record and e.record.model_id == MODEL_ID
    ]
    assert matches, "written outcome must be recalled under the default entry_types"
    rec = matches[0].record
    assert rec is not None
    assert rec.kind == "outcome"
    assert rec.outcome == "success"

    # recorded_at (schema v2) survives the metadata round-trip ~at the write time.
    assert rec.recorded_at is not None
    assert written.recorded_at is not None
    assert abs(rec.recorded_at - written.recorded_at) < 60.0


# --------------------------------------------------------------------------------------
# 3. explain round-trip
# --------------------------------------------------------------------------------------
async def test_recall_explain_roundtrip_live():
    settings = _base_settings(minima_recall_explain=True)
    memory = MubitMemory(settings)
    lane = settings.lane(_ns())

    await _write_outcome(memory, lane)

    recall = await _recall_until_model(memory, lane=lane, model_id=MODEL_ID)
    assert recall.error is None
    assert recall.timed_out is False
    assert recall.evidence, "explain=True recall must still return evidence"

    # Raw low-level check: the server echoes per-evidence explain_info when explain=True.
    raw = await threadpool.run(
        memory._client._control.query,  # noqa: SLF001 (test introspection)
        {
            "run_id": lane,
            "query": TASK,
            "mode": settings.minima_recall_mode,
            "limit": 25,
            "include_working_memory": False,
            "prefer_current_run": True,
            "lane_filter": lane,
            "entry_types": ["fact", "observation"],
            "explain": True,
        },
    )
    assert isinstance(raw, dict)
    raw_evidence = raw.get("evidence") or []
    assert raw_evidence
    assert any(
        isinstance(ev, dict) and isinstance(ev.get("explain_info"), dict)
        for ev in raw_evidence
    ), "server must attach explain_info to evidence when explain=True"


# --------------------------------------------------------------------------------------
# 4. min_timestamp window keeps fresh records
# --------------------------------------------------------------------------------------
async def test_recall_min_timestamp_keeps_fresh_record_live():
    # max_age_days=1 -> min_timestamp = now - 86400s; the just-written record is fresh
    # and must survive the window. (The excluding direction needs an aged record and is
    # deliberately not tested live.)
    settings = _base_settings(minima_recall_max_age_days=1)
    memory = MubitMemory(settings)
    lane = settings.lane(_ns())

    await _write_outcome(memory, lane)

    recall = await _recall_until_model(memory, lane=lane, model_id=MODEL_ID)
    assert recall.error is None
    assert recall.timed_out is False
    recalled_models = {e.record.model_id for e in recall.outcome_evidence if e.record}
    assert MODEL_ID in recalled_models


# --------------------------------------------------------------------------------------
# 5. dereference exact re-read
# --------------------------------------------------------------------------------------
async def test_dereference_roundtrip_live():
    settings = _base_settings()
    memory = MubitMemory(settings)
    lane = settings.lane(_ns())

    record_id, _written = await _write_outcome(memory, lane)

    # remember(wait=True) commits the write; allow a brief grace for read visibility.
    evidence = None
    for _ in range(5):
        evidence = await memory.dereference(lane=lane, reference_id=record_id)
        if evidence is not None:
            break
        time.sleep(1.0)

    assert evidence is not None, "dereference must re-read the durable outcome"
    assert evidence.score == 1.0
    assert evidence.reference_id == record_id
    assert evidence.record is not None
    assert evidence.record.kind == "outcome"
    assert evidence.record.model_id == MODEL_ID
