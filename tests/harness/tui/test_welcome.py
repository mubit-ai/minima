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


def test_render_welcome_is_a_clean_splash(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    out = _render_text(app)
    assert "█" in out  # the ASCII MINIMA banner
    assert "CLI" in out  # banner subtitle
    assert "recommend" in out and "memory" in out  # workflow strap
    assert "commands" in out  # onboarding hint kept
    # live status now lives ONLY in the footer — no duplicate status line in the welcome
    assert "session:" not in out
    assert "tools:" not in out
    assert "theme:" not in out


def test_render_welcome_shows_a_command_tip(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    out = _render_text(app)
    assert "💡" in out  # the rotating onboarding tip
    assert "Tip ·" in out
    assert "/" in out  # the tip names a /command


def test_welcome_nudges_when_no_provider_key(tmp_path, monkeypatch):
    from minima_harness.ai.provider_catalog import PROVIDERS

    for p in PROVIDERS:
        for var in p.env_vars:
            monkeypatch.delenv(var, raising=False)
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    out = _render_text(app)
    assert "no API keys found" in out
    assert "minima config" in out


def test_welcome_no_nudge_when_provider_key_present(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-present")
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    out = _render_text(app)
    assert "no API keys found" not in out


@pytest.mark.asyncio
async def test_welcome_centered_then_dismissed(tmp_path):
    cfg = HarnessConfig(allow_offline=True)
    app = HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=MinimaAgent(cfg, tools=[]), cwd=tmp_path
    )
    from minima_harness.tui.widgets.messages import ChatLog

    async with app.run_test() as pilot:
        await pilot.pause()
        chatlog = app.query_one(ChatLog)
        assert app.query_one("#welcome") is not None
        assert chatlog.has_class("empty")  # centered splash, no void
        app._dismiss_welcome()
        await pilot.pause()
        assert not app.query("#welcome")  # gone after the first turn
        assert not chatlog.has_class("empty")


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
