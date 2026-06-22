from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.overlays import ModelPicker
from minima_harness.tui.widgets.footer import render_footer


def test_footer_shows_model_and_basis_explicitly():
    text = str(
        render_footer("d", "s", "gemini-2.5-flash", "memory", CostMeter(), 1, 2, 0, 0, 12.0, False)
    )
    assert "model: gemini-2.5-flash ▸ memory" in text
    assert "ctx 12%" in text


@pytest.mark.asyncio
async def test_scroll_actions_run_without_error(tmp_path):
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    async with app.run_test():
        app.action_scroll_up()  # paging the transcript should not raise
        app.action_scroll_down()


@pytest.mark.asyncio
async def test_model_picker_header_and_active_selectable():
    class _App(App):
        result: str | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                ModelPicker(
                    ["a", "b"],
                    active="a",
                    basis="memory",
                    pinned=None,
                    providers={"a": "anthropic"},
                ),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        # header Static + OptionList both mounted
        assert len(app.screen.query(Static)) >= 1
        await pilot.press("enter")  # select highlighted first option ("a")
        await pilot.pause()
    assert app.result == "a"
