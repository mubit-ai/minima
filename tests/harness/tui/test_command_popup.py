from __future__ import annotations

import pytest
from textual.widgets import OptionList

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.widgets.editor import Editor


@pytest.mark.asyncio
async def test_command_popup_filters_and_tab_completes():
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.focus()
        await pilot.press("/")
        await pilot.press("m")
        await pilot.press("o")
        await pilot.pause()

        popup = app.query_one("#cmd-popup", OptionList)
        assert popup.has_class("visible")  # popup shown for "/mo"
        # Tab completes "/mo" → "/model "
        await pilot.press("tab")
        await pilot.pause()
        assert ed.text == "/model "
        assert not popup.has_class("visible")


@pytest.mark.asyncio
async def test_command_popup_hidden_for_non_command_text():
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    async with app.run_test() as pilot:
        ed = app.query_one(Editor)
        ed.focus()
        await pilot.press("h")
        await pilot.press("i")
        await pilot.pause()
        assert not app.query_one("#cmd-popup", OptionList).has_class("visible")
