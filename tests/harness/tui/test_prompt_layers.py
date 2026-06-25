from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from minima_harness.tui import mubit as mb


def test_layers_join_equals_effective_prompt_local(tmp_path, monkeypatch):
    """The single-source guarantee: joining the layers == effective_prompt."""
    monkeypatch.setattr(mb, "_initialized", False)
    (tmp_path / "AGENTS.md").write_text("PROJECT RULES")
    layers = mb.prompt_layers(tmp_path, session_override="BE TERSE")
    joined = "\n\n".join(layer.rendered for layer in layers)
    assert joined == mb.effective_prompt(tmp_path, session_override="BE TERSE")


def test_layers_split_base_and_project_context(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", False)
    (tmp_path / "AGENTS.md").write_text("PROJECT RULES")
    names = [layer.name for layer in mb.prompt_layers(tmp_path)]
    assert names == ["base prompt", "project context"]


def test_layers_with_mubit_prompt_and_lessons(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", True)
    monkeypatch.setattr(mb, "get_prompt", lambda: "MUBIT PROMPT")
    monkeypatch.setattr(mb, "learned", lambda: "LESSON: be terse")
    layers = mb.prompt_layers(tmp_path, session_override="SESS")
    names = [layer.name for layer in layers]
    assert names == ["system prompt", "session override", "lessons (Mubit)"]
    # editable targets: system prompt -> project, override -> session
    by_name = {layer.name: layer for layer in layers}
    assert by_name["system prompt"].editable_target == "project"
    assert by_name["session override"].editable_target == "session"
    assert by_name["lessons (Mubit)"].editable_target is None


def test_layer_token_breakdown_sums(tmp_path, monkeypatch):
    monkeypatch.setattr(mb, "_initialized", False)
    (tmp_path / "AGENTS.md").write_text("PROJECT RULES")
    b = mb.layer_token_breakdown(tmp_path, messages=[], session_override="")
    assert b["system"] == sum(t for _, t in b["layers"])
    assert b["total"] == b["system"] + b["history"]
    assert b["layers"]  # at least the base layer is present


@pytest.mark.asyncio
async def test_layered_inspector_saves_project_and_session(tmp_path, monkeypatch):
    from textual.widgets import TextArea

    from minima_harness.tui.overlays import LayeredPromptInspector

    monkeypatch.setattr(mb, "_initialized", False)
    layers = mb.prompt_layers(tmp_path)
    breakdown = mb.layer_token_breakdown(tmp_path, messages=[])

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                LayeredPromptInspector(layers, "PROJ", "SESS", breakdown),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        # edit the project area, then save it to "Mubit"
        app.screen.query_one("#edit-project", TextArea).text = "NEW SYSTEM"
        app.screen.action_save_project()
        await pilot.pause()
    assert app.result == {"action": "project", "content": "NEW SYSTEM"}


@pytest.mark.asyncio
async def test_layered_inspector_save_session(tmp_path, monkeypatch):
    from minima_harness.tui.overlays import LayeredPromptInspector

    monkeypatch.setattr(mb, "_initialized", False)
    layers = mb.prompt_layers(tmp_path)
    breakdown = mb.layer_token_breakdown(tmp_path, messages=[])

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                LayeredPromptInspector(layers, "", "OVERRIDE TEXT", breakdown),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        app.screen.action_save_session()
        await pilot.pause()
    assert app.result == {"action": "session", "content": "OVERRIDE TEXT"}
