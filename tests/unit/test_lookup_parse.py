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


class _ClientWithLookup:
    def __init__(self):
        self.native_calls: list[dict] = []

    def lookup(self, *, session_id=None, match=None, limit=256):
        self.native_calls.append({"session_id": session_id, "match": match, "limit": limit})
        return []


async def test_adapter_lookup_drives_native_client_lookup():
    """The keyed channel must use the public Client.lookup (mubit-sdk >= 0.13.0).

    This channel once degraded silently on every prod recommend because the
    pinned SDK had no lookup method; the shim that papered over that is gone,
    so pin the adapter to the native call.
    """
    from minima.config import Settings
    from minima.memory.adapter import MubitMemory

    memory = MubitMemory(Settings())
    client = _ClientWithLookup()
    memory._client = client
    result = await memory.lookup(lane="minima:proj-x", match=[{"kind": "outcome"}], limit=64)
    assert result == []
    assert client.native_calls == [
        {"session_id": "minima:proj-x", "match": [{"kind": "outcome"}], "limit": 64}
    ]
