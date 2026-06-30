from __future__ import annotations

import pytest
from textual.app import App

from minima_harness.tools.question import QuestionOption
from minima_harness.tui.overlays import QuestionOverlay


class _Host(App):
    """Minimal host app that pushes a QuestionOverlay and records its dismiss value."""

    def __init__(self, overlay: QuestionOverlay) -> None:
        super().__init__()
        self._overlay = overlay
        self.result: object = "__unset__"

    def on_mount(self) -> None:
        self.push_screen(self._overlay, lambda value: setattr(self, "result", value))


@pytest.mark.asyncio
async def test_overlay_selects_highlighted_option():
    overlay = QuestionOverlay(
        "pick one",
        "topic",
        [QuestionOption(label="first"), QuestionOption(label="second", description="the 2nd")],
        allow_freetext=True,
    )
    app = _Host(overlay)
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")  # highlight moves first -> second
        await pilot.press("enter")
        await pilot.pause()
    assert app.result == {"answer": "second"}


@pytest.mark.asyncio
async def test_overlay_custom_freetext_answer():
    overlay = QuestionOverlay(
        "pick", "", [QuestionOption(label="a")], allow_freetext=True
    )
    app = _Host(overlay)
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("t")  # reveal the custom-answer Input (non-priority binding)
        await pilot.pause()
        await pilot.press(*"custom")  # 't'-containing text lands in the Input, not the binding
        await pilot.press("enter")
        await pilot.pause()
    assert app.result == {"answer": "custom"}


@pytest.mark.asyncio
async def test_overlay_escape_dismisses_to_none():
    overlay = QuestionOverlay("pick", "", [QuestionOption(label="a")], allow_freetext=False)
    app = _Host(overlay)
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
    assert app.result is None
