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


def test_mouse_defaults_on_and_no_mouse_disables():
    from minima_harness.tui.cli import _build_parser

    p = _build_parser()
    assert p.parse_args([]).mouse is True  # capture ON by default → scroll-wheel works
    assert p.parse_args(["--mouse"]).mouse is True
    assert p.parse_args(["--no-mouse"]).mouse is False  # opt into terminal-native selection


def test_selection_hint_is_mode_and_os_aware(monkeypatch):
    monkeypatch.setattr(welcomemod.sys, "platform", "darwin")
    on_mac = welcomemod.selection_hint(True)
    assert "Option" in on_mac and "/mouse" in on_mac  # macOS bypass modifier
    monkeypatch.setattr(welcomemod.sys, "platform", "linux")
    assert "Shift" in welcomemod.selection_hint(True)  # Linux bypass modifier
    off = welcomemod.selection_hint(False)
    assert "PageUp" in off  # mouse off → scroll via keyboard, native selection


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
