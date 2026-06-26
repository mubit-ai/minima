"""Mouse capture vs. text selection: both should be usable.

Terminal mouse-tracking is all-or-nothing — with it on the wheel scrolls but the terminal's
native click-drag selection is suppressed. Textual 8.x provides its own in-app selection + copy,
but its copy_to_clipboard emits ONLY OSC 52 (ignored by macOS Terminal.app). These tests cover:
mouse defaults ON, copy_to_clipboard also pushes to the OS clipboard, /mouse toggles live, and the
selection hint is mouse-mode + OS aware.
"""

from __future__ import annotations

import pytest

import minima_harness.tui.app as appmod
import minima_harness.tui.welcome as welcomemod
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp


def test_mouse_flag_is_tristate_and_explicit_wins():
    from minima_harness.tui.cli import _build_parser

    p = _build_parser()
    assert p.parse_args([]).mouse is None  # unset → resolved per-terminal
    assert p.parse_args(["--mouse"]).mouse is True
    assert p.parse_args(["--no-mouse"]).mouse is False


def test_resolve_mouse_defaults_off_on_apple_terminal(monkeypatch):
    from minima_harness.tui.cli import _resolve_mouse

    # Explicit flag always wins, regardless of terminal.
    monkeypatch.setenv("TERM_PROGRAM", "Apple_Terminal")
    assert _resolve_mouse(True) is True
    assert _resolve_mouse(False) is False
    # Unset → OFF on macOS Terminal.app (can't drag-select), ON elsewhere.
    assert _resolve_mouse(None) is False
    monkeypatch.setenv("TERM_PROGRAM", "iTerm.app")
    assert _resolve_mouse(None) is True
    monkeypatch.delenv("TERM_PROGRAM", raising=False)
    assert _resolve_mouse(None) is True


def test_selection_hint_is_mode_and_terminal_aware(monkeypatch):
    off = welcomemod.selection_hint(False)
    assert "PageUp" in off and "/mouse" in off  # mouse off → native selection + keyboard scroll
    monkeypatch.setenv("TERM_PROGRAM", "Apple_Terminal")
    on_term = welcomemod.selection_hint(True)
    assert "Terminal.app" in on_term and "/mouse off" in on_term  # honest about the limitation
    monkeypatch.setenv("TERM_PROGRAM", "iTerm.app")
    on_iterm = welcomemod.selection_hint(True)
    assert "Ctrl+C" in on_iterm  # in-app drag-select + copy works in motion-reporting terminals


def _app(tmp_path, *, mouse=True):
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    return HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=agent, cwd=tmp_path, mouse=mouse
    )


@pytest.mark.asyncio
async def test_copy_to_clipboard_also_pushes_to_os_clipboard(tmp_path, monkeypatch):
    # Textual's own copy is OSC-52-only (dead on macOS Terminal.app); the override must also push
    # to the OS clipboard tool so a drag-selection + ⌘/Ctrl+C actually lands on the clipboard.
    captured: list[str] = []
    monkeypatch.setattr(appmod, "_os_clipboard_copy", lambda t: captured.append(t) or True)
    app = _app(tmp_path)
    async with app.run_test():
        app.copy_to_clipboard("hello clipboard")
        await app.workers.wait_for_complete()
    assert "hello clipboard" in captured


@pytest.mark.asyncio
async def test_mouse_command_toggles_capture(tmp_path):
    app = _app(tmp_path, mouse=True)
    seen: list[bool] = []
    async with app.run_test() as pilot:
        # Stub the driver-level toggle (headless test driver can't really enable/disable mouse).
        app._set_mouse_capture = lambda enabled: (  # type: ignore[method-assign]
            seen.append(enabled) or setattr(app, "_mouse_enabled", enabled) or True
        )
        await app._dispatch_command("mouse", "off")
        await pilot.pause()
        assert seen == [False] and app._mouse_enabled is False
        await app._dispatch_command("mouse", "")  # bare → toggle back on
        await pilot.pause()
        assert seen == [False, True] and app._mouse_enabled is True


def test_set_mouse_capture_is_graceful_without_driver(tmp_path):
    # Before the app is running there is no driver — _set_mouse_capture must report False, not
    # crash, and leave the mode unchanged.
    app = _app(tmp_path)
    assert getattr(app, "_driver", None) is None
    assert app._set_mouse_capture(False) is False
    assert app._mouse_enabled is True
