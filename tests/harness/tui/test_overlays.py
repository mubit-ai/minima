from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from minima_harness.session import SessionStore
from minima_harness.tui.overlays import ModelPicker, TreePicker


@pytest.mark.asyncio
async def test_model_picker_dismisses_with_selection():
    class _App(App):
        result: str | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                ModelPicker(["a", "b"], "a"), callback=lambda r: setattr(self, "result", r)
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")  # highlight "b"
        await pilot.pause()
        await pilot.press("enter")  # select -> dismiss("b")
        await pilot.pause()
    assert app.result == "b"


@pytest.mark.asyncio
async def test_model_picker_escape_cancels():
    class _App(App):
        result: str | None = "unchanged"

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                ModelPicker(["a", "b"], None), callback=lambda r: setattr(self, "result", r)
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
    assert app.result is None


@pytest.mark.asyncio
async def test_tree_picker_renders_session():
    from minima_harness.session.format import EntryType

    store = SessionStore.in_memory()
    store.append(EntryType.USER, {"text": "hi"})
    store.append(EntryType.ASSISTANT, {"text": "yo"})

    class _App(App):
        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(TreePicker(store))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
