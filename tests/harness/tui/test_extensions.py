from __future__ import annotations

import pytest

from minima_harness.tui import extensions as extmod

EXT_SRC = '''
from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult
from minima_harness.ai.types import TextContent


class P(BaseModel):
    x: str = ""


async def _ex(tool_call_id, params, signal, on_update):
    return ToolResult(content=[TextContent(text="ext")])


def register(api):
    api.tool(AgentTool(name="extool", description="d", parameters=P, execute=_ex))

    @api.command("extcmd", description="ext")
    async def _c(app, args):
        return None

    @api.on("finish")
    def _f(event):
        return None
'''


def _make(tmp_path, monkeypatch):
    monkeypatch.setattr(extmod, "GLOBAL_DIR", tmp_path / "global")
    extdir = tmp_path / "global" / "extensions"
    extdir.mkdir(parents=True)
    return extdir


def test_load_extension_registers_tools_commands_hooks(tmp_path, monkeypatch):
    extdir = _make(tmp_path, monkeypatch)
    (extdir / "ext.py").write_text(EXT_SRC)
    apis = extmod.load_extensions(tmp_path)
    assert len(apis) == 1
    api = apis[0]
    assert api.name == "ext"
    assert any(t.name == "extool" for t in api.tools)
    assert "extcmd" in api.commands
    assert len(api.hooks["finish"]) == 1


def test_load_extensions_skips_broken(tmp_path, monkeypatch):
    extdir = _make(tmp_path, monkeypatch)
    (extdir / "bad.py").write_text("raise RuntimeError('boom')")
    (extdir / "good.py").write_text("def register(api):\n    pass\n")
    apis = extmod.load_extensions(tmp_path)
    assert [a.name for a in apis] == ["good"]


@pytest.mark.asyncio
async def test_app_applies_extension_tools_and_commands(tmp_path, monkeypatch):
    extdir = _make(tmp_path, monkeypatch)
    (extdir / "ext.py").write_text(EXT_SRC)

    from minima_harness.minima.config import HarnessConfig
    from minima_harness.minima.runtime import MinimaAgent
    from minima_harness.session import SessionStore
    from minima_harness.tui.app import HarnessApp

    cfg = HarnessConfig(allow_offline=True)
    agent = MinimaAgent(cfg, tools=[])
    app = HarnessApp(cfg, session=SessionStore.in_memory(), agent=agent, cwd=tmp_path)
    assert any(t.name == "extool" for t in app.agent.state.tools)
    assert app.commands.get("extcmd") is not None
