from __future__ import annotations

from types import SimpleNamespace

import pytest
from textual.app import App, ComposeResult
from textual.widgets import OptionList, Static

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import _confidence_band, _reasoner_note
from minima_harness.tui.overlays import ModelPicker
from minima_harness.tui.widgets.footer import render_footer


def test_footer_shows_model_and_basis_explicitly():
    text = str(
        render_footer("d", "s", "gemini-2.5-flash", "memory", CostMeter(), 1, 2, 0, 0, 12.0, False)
    )
    assert "model: gemini-2.5-flash ▸ memory" in text
    assert "ctx 12%" in text


def _routing(predicted: float, tau: float, confidence: float, warnings: list[str] | None = None):
    return SimpleNamespace(
        chosen_model_id="m",
        model=SimpleNamespace(id="m"),
        ranked=[SimpleNamespace(model_id="m", predicted_success=predicted)],
        threshold_used=tau,
        confidence=confidence,
        warnings=list(warnings or []),
    )


def test_confidence_band_green_amber_red():
    assert _confidence_band(_routing(0.9, 0.7, 0.8))[1] == "green"  # confident + clears
    assert _confidence_band(_routing(0.9, 0.7, 0.2))[1] == "yellow"  # clears but uncertain
    assert _confidence_band(_routing(0.6, 0.7, 0.9))[1] == "red"  # doesn't clear tau
    assert _confidence_band(_routing(0.9, 0.7, 0.9, ["no_model_meets_threshold"]))[1] == "red"


def test_reasoner_note_surfaces_escalation():
    assert "reasoner" in _reasoner_note(_routing(0.9, 0.7, 0.8, ["reasoner_consulted"]))
    assert "thin" in _reasoner_note(_routing(0.9, 0.7, 0.8, ["escalation_suggested:thin_evidence"]))
    assert _reasoner_note(_routing(0.9, 0.7, 0.8, [])) == ""


def test_footer_shows_route_mode():
    s = str(
        render_footer(
            "d", "s", "m", "memory", CostMeter(), 1, 2, 0, 0, 1.0, False, route_mode="confirm"
        )
    )
    assert "route: confirm" in s


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
async def test_model_picker_titled_and_active_selectable():
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
        # bordered OptionList card titled "model"; status moved to the border subtitle
        ol = app.screen.query_one(OptionList)
        assert ol.border_title == "model"
        assert "basis memory" in str(ol.border_subtitle)
        await pilot.press("down")  # row 0 is the auto/unpin entry; step to "a"
        await pilot.press("enter")
        await pilot.pause()
    assert app.result == "a"
