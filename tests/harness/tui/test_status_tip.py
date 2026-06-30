from __future__ import annotations

from rich.console import Console

from minima_harness.tui.widgets.status import StatusBar


def _rendered(bar: StatusBar) -> str:
    # _status_renderable() is the pure renderable builder (no mounted app needed).
    console = Console(record=True, width=80)
    console.print(bar._status_renderable())
    return console.export_text()


def test_tip_shows_beside_spinner_when_busy():
    bar = StatusBar()
    # Set state/tip directly: set_tip()/set_state() would call _display()→update(), which needs a
    # mounted app. _status_renderable() is the pure path we assert on.
    bar._state = "working"
    bar._tip = "💡 /recall pulls lessons from past sessions"
    out = _rendered(bar)
    assert "working" in out
    assert "💡" in out and "/recall" in out


def test_tip_hidden_when_idle():
    bar = StatusBar()
    bar.set_tip("💡 /recall pulls lessons from past sessions")
    # state stays idle → idle text only, no tip leaking into the resting status line
    out = _rendered(bar)
    assert "💡" not in out


def test_set_state_is_idempotent():
    bar = StatusBar()
    # No timer mounted; repeated same-state calls must be a no-op and never raise.
    bar.set_state("idle")
    bar.set_state("idle")
    assert bar._state == "idle"
