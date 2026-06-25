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
                ModelPicker(["a", "b"], active="a"), callback=lambda r: setattr(self, "result", r)
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        # options are [auto, a, b]; two downs from the top lands on "b"
        await pilot.press("down")
        await pilot.press("down")
        await pilot.pause()
        await pilot.press("enter")  # select -> dismiss("b")
        await pilot.pause()
    assert app.result == "b"


@pytest.mark.asyncio
async def test_model_picker_offers_auto_unpin_first():
    from minima_harness.tui.overlays import ModelPicker

    class _App(App):
        result: str | None = "unset"

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            # a model is pinned -> the first row is the unpin/auto affordance
            self.push_screen(
                ModelPicker(["a", "b"], pinned="a"),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        from textual.widgets import OptionList

        ol = app.screen.query_one(OptionList)
        assert ol.get_option_at_index(0).id == ModelPicker.AUTO
        assert "auto" in str(ol.get_option_at_index(0).prompt)
        await pilot.press("enter")  # top row = auto -> dismiss(AUTO)
        await pilot.pause()
    assert app.result == ModelPicker.AUTO


@pytest.mark.asyncio
async def test_model_picker_escape_cancels():
    class _App(App):
        result: str | None = "unchanged"

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                ModelPicker(["a", "b"], active=None), callback=lambda r: setattr(self, "result", r)
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
