from __future__ import annotations

import pytest

from minima_harness.session.format import EntryType
from minima_harness.session.store import SessionStore, format_age


def test_format_age_buckets():
    now = 100_000_000.0
    assert format_age(now, now) == "just now"
    assert format_age(now - 30, now) == "just now"
    assert format_age(now - 120, now) == "2m ago"
    assert format_age(now - 2 * 3600, now) == "2h ago"
    assert format_age(now - 3 * 86400, now) == "3d ago"
    assert format_age(now - 14 * 86400, now) == "2w ago"


def test_format_age_handles_missing_or_future():
    assert format_age(0.0, 100_000_000.0) == "?"
    assert format_age(-1.0, 100_000_000.0) == "?"
    assert format_age(100_000_100.0, 100_000_000.0) == "just now"  # clock skew → clamp


def test_in_memory_append_tracks_tip():
    store = SessionStore.in_memory()
    a = store.append(EntryType.USER, {"text": "hello"})
    b = store.append(EntryType.ASSISTANT, {"text": "hi back"})
    assert a.parent_id is None
    assert b.parent_id == a.id
    assert store.tip == b.id


def test_file_backed_round_trip(tmp_path):
    store = SessionStore.file_backed(tmp_path / "s.jsonl")
    store.append(EntryType.USER, {"text": "one"})
    store.append(EntryType.ASSISTANT, {"text": "two"})
    again = SessionStore.file_backed(tmp_path / "s.jsonl")
    assert len(again.entries) == 2
    assert again.tip == again.entries[-1].id
    assert again.entries[0].type is EntryType.USER


def test_file_backed_skips_malformed_lines(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_text(
        '{"id":"x","type":"user","payload":{}}\nNOT JSON\n'
        '{"id":"y","type":"assistant","payload":{}}\n'
    )
    store = SessionStore.file_backed(p)
    assert [e.id for e in store.entries] == ["x", "y"]


def test_set_tip_branches_from_prior_entry():
    store = SessionStore.in_memory()
    a = store.append(EntryType.USER, {"n": 1})
    b = store.append(EntryType.ASSISTANT, {"n": 2})
    store.set_tip(a.id)
    c = store.append(EntryType.USER, {"n": 3})
    assert c.parent_id == a.id
    assert store.tip == c.id
    assert b.parent_id == a.id  # b unchanged


def test_set_tip_rejects_unknown_id():
    store = SessionStore.in_memory()
    store.append(EntryType.USER, {"n": 1})
    with pytest.raises(KeyError):
        store.set_tip("does-not-exist")


def test_path_to_returns_root_to_entry():
    store = SessionStore.in_memory()
    a = store.append(EntryType.USER, {})
    store.append(EntryType.ASSISTANT, {})
    c = store.append(EntryType.USER, {})
    assert [e.id for e in store.path_to(c.id)] == [a.id, store.entries[1].id, c.id]


def test_children_map_groups_by_parent():
    store = SessionStore.in_memory()
    a = store.append(EntryType.USER, {})
    store.append(EntryType.ASSISTANT, {})
    store.set_tip(a.id)
    store.append(EntryType.USER, {})  # branch child of a
    cm = store.children_map()
    assert len(cm[a.id]) == 2  # two children of a (the assistant + the branch)


def test_fork_copies_path_to_new_file(tmp_path):
    src = SessionStore.file_backed(tmp_path / "a.jsonl")
    a = src.append(EntryType.USER, {"n": 1})
    src.append(EntryType.ASSISTANT, {"n": 2})
    dest = tmp_path / "b.jsonl"
    src.fork_to(dest, from_entry_id=a.id)
    forked = SessionStore.file_backed(dest)
    assert [e.id for e in forked.entries] == [a.id]  # only the root→a path
    assert forked.tip == a.id


def test_clone_copies_current_branch(tmp_path):
    src = SessionStore.file_backed(tmp_path / "a.jsonl")
    a = src.append(EntryType.USER, {"n": 1})
    b = src.append(EntryType.ASSISTANT, {"n": 2})
    dest = tmp_path / "c.jsonl"
    src.clone_to(dest)
    cloned = SessionStore.file_backed(dest)
    assert [e.id for e in cloned.entries] == [a.id, b.id]
    assert cloned.tip == b.id
