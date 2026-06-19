from __future__ import annotations

from minima_harness.session.format import EntryType, SessionEntry, new_id


def test_entry_round_trips_json():
    e = SessionEntry(id=new_id(), parent_id=None, type=EntryType.USER, payload={"text": "hi"})
    js = e.model_dump_json()
    back = SessionEntry.model_validate_json(js)
    assert back.type is EntryType.USER
    assert back.payload == {"text": "hi"}
    assert back.parent_id is None


def test_entry_default_ts_and_label():
    e = SessionEntry(id=new_id(), type=EntryType.SYSTEM, payload={})
    assert e.ts >= 0.0
    assert e.label is None


def test_new_id_is_unique():
    a, b = new_id(), new_id()
    assert a != b and len(a) == 12
