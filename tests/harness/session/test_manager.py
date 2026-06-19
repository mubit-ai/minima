from __future__ import annotations

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
