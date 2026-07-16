"""Keyed-lookup evidence parsing: node-id vs fact-UUID id spaces."""

from __future__ import annotations

from minima.memory.adapter import _parse_lookup_record

FACT_UUID = "814b0fd0-46f4-4f26-8db6-3e508b06a84c"


def _item(metadata: dict | None) -> dict:
    return {"id": 42137, "metadata": metadata}


def _outcome_meta(**extra) -> dict:
    return {
        "kind": "outcome",
        "model_id": "claude-haiku-4-5",
        "task_type": "code",
        "difficulty": "hard",
        "task_cluster": "code:hard",
        "quality_score": 0.9,
        "outcome": "success",
        "evidence_source": "judge",
        **extra,
    }


def test_lookup_hit_without_fact_uuid_is_not_referenceable():
    ev = _parse_lookup_record(_item(_outcome_meta()))
    assert ev is not None
    assert ev.entry_id == "42137"
    assert ev.reference_id is None
    assert ev.referenceable is False
    assert ev.record is not None and ev.record.model_id == "claude-haiku-4-5"


def test_lookup_hit_with_fact_uuid_uses_it_as_reference():
    ev = _parse_lookup_record(_item(_outcome_meta(id=FACT_UUID)))
    assert ev is not None
    assert ev.entry_id == "42137"
    assert ev.reference_id == FACT_UUID
    assert ev.referenceable is True


def test_lookup_hit_never_uses_node_id_as_reference():
    ev = _parse_lookup_record(_item(_outcome_meta(id="42137")))
    assert ev is not None
    assert ev.reference_id is None
    assert ev.referenceable is False


def test_lookup_hit_without_record_is_dropped():
    assert _parse_lookup_record(_item({"kind": "note"})) is None
    assert _parse_lookup_record({"metadata": _outcome_meta()}) is None
