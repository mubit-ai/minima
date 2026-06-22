from __future__ import annotations

import pytest
from rich.console import Console
from textual.app import App, ComposeResult
from textual.widgets import Static

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.commands import Command
from minima_harness.tui.overlays import CommandPicker
from minima_harness.tui.welcome import DIAGRAM, render_welcome


def _render_text(app: HarnessApp) -> str:
    console = Console(record=True, width=80)
    console.print(render_welcome(app))
    return console.export_text()


def test_diagram_contains_the_loop():
    assert "recommend" in DIAGRAM and "feedback" in DIAGRAM and "judge" in DIAGRAM


def test_render_welcome_has_status_panel(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    out = _render_text(app)
    assert "minima-harness" in out
    assert "session:" in out and "tools:" in out
    assert "/commands" in out


@pytest.mark.asyncio
async def test_welcome_mounted_on_startup(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.query_one("#welcome") is not None


@pytest.mark.asyncio
async def test_command_picker_dismisses_with_chosen():
    async def _h(app, args):  # noqa: ANN001
        return None

    cmds = [
        Command(name="model", handler=_h, description="pick model"),
        Command(name="cost", handler=_h, description="cost meter"),
    ]

    class _App(App):
        result: str | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(CommandPicker(cmds), callback=lambda r: setattr(self, "result", r))

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")  # highlight "cost"
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()
    assert app.result == "cost"
