from __future__ import annotations

import json

import pytest

from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui import theme
from minima_harness.tui.app import HarnessApp
from minima_harness.tui.widgets.editor import Editor


def test_reload_file_themes_makes_them_settable(tmp_path, monkeypatch):
    from minima_harness.tui import customize

    monkeypatch.setattr(customize, "GLOBAL_DIR", tmp_path / "global")
    th = tmp_path / "global" / "themes"
    th.mkdir(parents=True)
    (th / "nord.json").write_text(json.dumps({"user": "#abc", "assistant": "#def"}))
    try:
        theme.reload_file_themes(tmp_path)
        assert "nord" in theme.available_themes()
        theme.set_theme("nord")
        assert theme.get_theme("nord")["user"] == "#abc"
    finally:
        theme.set_theme("dark")


@pytest.mark.asyncio
async def test_skill_command_appends_to_system_prompt():
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[], system_prompt="BASE")
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    app._skills = {"debug": "Be terse."}
    async with app.run_test() as pilot:
        await app._dispatch_command("skill:debug", "")
        await pilot.pause()
    sp = app.agent.state.system_prompt or ""
    assert "Be terse." in sp
    assert "# Skill: debug" in sp


@pytest.mark.asyncio
async def test_template_command_inserts_into_editor():
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    app._templates = {"review": "Review this code."}
    async with app.run_test() as pilot:
        await app._dispatch_command("review", "")
        await pilot.pause()
        assert app.query_one(Editor).text == "Review this code."


@pytest.mark.asyncio
async def test_unknown_skill_reports_error():
    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent)
    app._skills = {}
    async with app.run_test() as pilot:
        await app._dispatch_command("skill:nope", "")
        await pilot.pause()
