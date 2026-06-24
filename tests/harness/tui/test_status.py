from __future__ import annotations

import pytest
from textual.app import App, ComposeResult

from minima_harness.tui.widgets.status import StatusBar


@pytest.mark.asyncio
async def test_status_bar_state_transitions():
    class _App(App):
        def compose(self) -> ComposeResult:
            yield StatusBar(id="status")

    app = _App()
    async with app.run_test():
        sb = app.query_one(StatusBar)
        sb.set_idle_text("model: gemini ▸ memory · ctx 12%")
        sb.set_state("thinking")
        assert sb._state == "thinking"
        sb.set_state("working")
        assert sb._state == "working"
        sb.set_state("idle")
        assert sb._state == "idle"
