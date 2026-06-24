from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from minima_harness.session import SessionStore
from minima_harness.tui import mubit as mb


def test_estimate_tokens():
    assert mb.estimate_tokens("abcd") == 1
    assert mb.estimate_tokens("abcdefgh") == 2


def test_effective_prompt_falls_back_to_local(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", False)
    (tmp_path / "AGENTS.md").write_text("PROJECT RULES")
    assert "PROJECT RULES" in mb.effective_prompt(tmp_path)


def test_effective_prompt_uses_mubit_and_lessons(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", True)
    monkeypatch.setattr(mb, "get_prompt", lambda: "MUBIT PROMPT")
    monkeypatch.setattr(mb, "learned", lambda: "LESSON: be terse")
    p = mb.effective_prompt(tmp_path)
    assert "MUBIT PROMPT" in p
    assert "LESSON: be terse" in p


def test_effective_prompt_appends_session_override(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", False)
    p = mb.effective_prompt(tmp_path, session_override="SESSION ONLY")
    assert "SESSION ONLY" in p


def test_session_override_roundtrip():
    from minima_harness.tui.context import get_session_override, set_session_override

    store = SessionStore.in_memory()
    assert get_session_override(store) == ""
    set_session_override(store, "OVERRIDE")
    assert get_session_override(store) == "OVERRIDE"


@pytest.mark.asyncio
async def test_prompt_inspector_save_project():
    from minima_harness.tui.overlays import PromptInspector

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                PromptInspector("BASE PROMPT", {"system": 10, "history": 20, "total": 30}),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.action_save_project()  # Ctrl+P binding (priority) — invoke the action directly
        await pilot.pause()
    assert app.result == {"action": "project", "content": "BASE PROMPT"}
