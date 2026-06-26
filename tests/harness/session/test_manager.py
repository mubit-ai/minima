from __future__ import annotations

import os

import pytest

from minima_harness.session.format import EntryType
from minima_harness.session.store import SessionManager


def test_slug_is_stable_across_calls(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    assert mgr.slug_for(tmp_path) == mgr.slug_for(tmp_path) and mgr.slug_for(tmp_path) != ""


def test_new_creates_file_under_slug_dir(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    store = mgr.new(tmp_path, name="demo")
    assert store.path is not None
    assert not store.path.exists()  # file is created lazily on first append
    assert store.display_name == "demo"


def test_list_sessions_and_most_recent(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    assert mgr.list_sessions(tmp_path) == []
    s1 = mgr.new(tmp_path)
    s1.append(EntryType.USER, {"x": 1})
    s2 = mgr.new(tmp_path)
    s2.append(EntryType.USER, {"x": 2})
    sessions = mgr.list_sessions(tmp_path)
    assert len(sessions) == 2
    recent = mgr.most_recent(tmp_path)
    assert recent is not None
    assert recent.path in {s1.path, s2.path}


def test_list_sessions_records_created_and_sorts_recent_first(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    s1 = mgr.new(tmp_path)
    e1 = s1.append(EntryType.USER, {"x": 1})
    s2 = mgr.new(tmp_path)
    s2.append(EntryType.USER, {"x": 2})
    # Force deterministic mtimes: s1 is the more recently used.
    os.utime(s1.path, (3000.0, 3000.0))
    os.utime(s2.path, (1000.0, 1000.0))

    sessions = mgr.list_sessions(tmp_path)
    assert [s.path for s in sessions] == [s1.path, s2.path]  # most-recently-used first
    assert sessions[0].created == pytest.approx(e1.ts)  # created = first entry's ts


def test_created_falls_back_to_mtime_for_empty_session(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    p = (tmp_path / "sessions" / mgr.slug_for(tmp_path) / "empty.jsonl")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("")  # session file with no entries
    [summary] = mgr.list_sessions(tmp_path)
    assert summary.n_entries == 0
    assert summary.created == summary.mtime  # no first entry → mtime


def test_list_sessions_tolerates_non_object_first_line(tmp_path):
    # A first line that is valid JSON but NOT an object (list/number/string) must not crash
    # list_sessions — created falls back to mtime, as SessionStore tolerates malformed lines.
    mgr = SessionManager(tmp_path / "sessions")
    d = tmp_path / "sessions" / mgr.slug_for(tmp_path)
    d.mkdir(parents=True, exist_ok=True)
    (d / "weird.jsonl").write_text("[1, 2, 3]\n")
    [summary] = mgr.list_sessions(tmp_path)
    assert summary.created == summary.mtime


def test_open_by_session_id_prefix(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    s = mgr.new(tmp_path)
    s.append(EntryType.USER, {"x": 1})
    reopened = mgr.open(tmp_path, session_id=s.path.stem[:6])  # prefix match
    assert len(reopened.entries) == 1


def test_in_memory_when_no_session_flag(tmp_path):
    mgr = SessionManager(tmp_path / "sessions")
    store = mgr.open(tmp_path, no_session=True)
    assert store.persistent is False
