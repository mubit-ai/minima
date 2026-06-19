from __future__ import annotations

import pytest
from textual.app import App, ComposeResult

from minima_harness.tui.widgets.editor import Editor


@pytest.mark.asyncio
async def test_editor_enter_submits_text():
    class _App(App):
        captured: list[str] = []

        def compose(self) -> ComposeResult:
            yield Editor()

        def on_mount(self) -> None:
            self.query_one(Editor).focus()

        def on_editor_submitted(self, event: Editor.Submitted) -> None:
            self.captured.append(event.text)

    app = _App()
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.text = "hello"
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()
    assert app.captured == ["hello"]


@pytest.mark.asyncio
async def test_editor_shift_enter_inserts_newline():
    class _App(App):
        def compose(self) -> ComposeResult:
            yield Editor()

        def on_mount(self) -> None:
            self.query_one(Editor).focus()

        def on_editor_submitted(self, event: Editor.Submitted) -> None:
            pass

    app = _App()
    async with app.run_test() as pilot:
        await pilot.press("a")
        await pilot.pause()
        await pilot.press("shift+enter")
        await pilot.pause()
        await pilot.press("b")
        await pilot.pause()
        assert app.query_one(Editor).text == "a\nb"
