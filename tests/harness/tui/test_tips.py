from __future__ import annotations

import json

from minima_harness.tui import tips


def test_every_tip_names_a_command():
    assert tips.TIPS, "there must be at least one tip"
    for body in tips.TIPS:
        assert body.strip()
        assert "/" in body, f"tip should reference a /command: {body!r}"


def test_pick_wraps_modulo_length():
    n = len(tips.TIPS)
    assert tips.pick(0) == tips.TIPS[0]
    assert tips.pick(n) == tips.TIPS[0]  # wraps
    assert tips.pick(n + 1) == tips.TIPS[1]


def test_format_tip_prefixes_lightbulb():
    assert tips.format_tip("/recall does things").startswith("💡 ")


def _point_state_at(tmp_path, monkeypatch):
    monkeypatch.setattr(tips, "GLOBAL_DIR", tmp_path)
    monkeypatch.setattr(tips, "STATE_FILE", tmp_path / "tips_state.json")


def test_advance_increments_and_persists(tmp_path, monkeypatch):
    _point_state_at(tmp_path, monkeypatch)
    first = tips.advance()
    second = tips.advance()
    assert first != second
    saved = json.loads((tmp_path / "tips_state.json").read_text())["index"]
    assert saved == second


def test_advance_falls_back_when_unwritable(tmp_path, monkeypatch):
    # Point at a path whose parent can't be created (a file used as a directory) → write fails,
    # but advance() must still return a valid index rather than raising.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a dir")
    monkeypatch.setattr(tips, "GLOBAL_DIR", blocker / "nested")
    monkeypatch.setattr(tips, "STATE_FILE", blocker / "nested" / "tips_state.json")
    idx = tips.advance()
    assert 0 <= idx < len(tips.TIPS)
