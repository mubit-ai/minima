"""StatusBar repaint discipline — the streaming path must not repaint the footer per token,
and the spinner timer must be paused while idle (no fan-spinning wakeups)."""

from __future__ import annotations

import pytest
from textual.app import App

from minima_harness.tui.widgets.status import StatusBar


class _App(App):
    def compose(self):  # noqa: ANN202
        yield StatusBar()


@pytest.mark.asyncio
async def test_set_state_is_idempotent_no_repaint_per_token():
    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        sb = app.query_one(StatusBar)
        calls = {"n": 0}
        orig = sb.update
        sb.update = lambda *a, **k: (calls.__setitem__("n", calls["n"] + 1), orig(*a, **k))[1]

        sb.set_state("working")  # 1 repaint (state changed idle -> working)
        for _ in range(200):  # simulate 200 token deltas all re-asserting "working"
            sb.set_state("working")
        # The 200 repeated same-state calls must NOT repaint (only the initial transition did).
        assert calls["n"] == 1


@pytest.mark.asyncio
async def test_spinner_timer_paused_when_idle():
    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        sb = app.query_one(StatusBar)
        # Starts paused at idle.
        assert sb._timer is not None and not sb._timer._active.is_set()
        sb.set_state("working")
        assert sb._timer._active.is_set()  # resumes while busy
        sb.set_state("idle")
        assert not sb._timer._active.is_set()  # paused again at idle
