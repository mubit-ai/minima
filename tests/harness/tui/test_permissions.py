"""Permission prompt before sensitive tool ops (write/edit/bash), default-on."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from minima_harness.ai import get_model
from minima_harness.ai.providers import ensure_providers_registered
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionStore
from minima_harness.tui.app import HarnessApp


def _app(skip_permissions: bool = False) -> HarnessApp:
    ensure_providers_registered()
    model = get_model("anthropic", "claude-haiku-4-5")
    cfg = HarnessConfig(minima_url="", candidates=["claude-haiku-4-5"], allow_offline=True)
    agent = MinimaAgent(cfg, model=model)
    return HarnessApp(
        cfg, session=SessionStore.in_memory(), agent=agent, skip_permissions=skip_permissions
    )


def _ctx(name: str, **args):
    return SimpleNamespace(tool_call=SimpleNamespace(name=name), args=SimpleNamespace(**args))


def _push_returning(result, calls):
    async def _p(screen, wait_for_dismiss=False):  # noqa: ANN001
        calls.append(getattr(screen, "_name", "?"))
        return result
    return _p


@pytest.mark.asyncio
async def test_reject_blocks_the_tool():
    app = _app()
    async with app.run_test():
        calls: list = []
        app.push_screen = _push_returning({"action": "reject"}, calls)  # type: ignore[method-assign]
        res = await app._tool_hook(_ctx("write", path="x.md", content="hi"))
    assert res is not None and res.block  # blocked
    assert "write" in calls  # the prompt was shown


@pytest.mark.asyncio
async def test_approve_allows_once_and_still_asks_next_time():
    app = _app()
    async with app.run_test():
        calls: list = []
        app.push_screen = _push_returning({"action": "approve"}, calls)  # type: ignore[method-assign]
        assert await app._tool_hook(_ctx("write", path="x.md", content="hi")) is None
        assert await app._tool_hook(_ctx("write", path="y.md", content="yo")) is None
    assert len(calls) == 2  # asked both times (approve is one-shot)


@pytest.mark.asyncio
async def test_always_allow_skips_subsequent_prompts():
    app = _app()
    async with app.run_test():
        calls: list = []
        app.push_screen = _push_returning({"action": "always"}, calls)  # type: ignore[method-assign]
        assert await app._tool_hook(_ctx("bash", command="ls")) is None
        # second call must NOT prompt — would KeyError if it tried (push replaced below)

        async def _explode(screen, wait_for_dismiss=False):  # noqa: ANN001
            raise AssertionError("should not prompt again after 'always'")

        app.push_screen = _explode  # type: ignore[method-assign]
        assert await app._tool_hook(_ctx("bash", command="pwd")) is None
    assert calls == ["bash"]  # prompted exactly once


@pytest.mark.asyncio
async def test_non_sensitive_tool_never_prompts():
    app = _app()
    async with app.run_test():
        async def _explode(screen, wait_for_dismiss=False):  # noqa: ANN001
            raise AssertionError("read must not prompt")

        app.push_screen = _explode  # type: ignore[method-assign]
        assert await app._tool_hook(_ctx("read", path="x.md")) is None


@pytest.mark.asyncio
async def test_skip_permissions_disables_prompt():
    app = _app(skip_permissions=True)
    async with app.run_test():
        async def _explode(screen, wait_for_dismiss=False):  # noqa: ANN001
            raise AssertionError("YOLO mode must not prompt")

        app.push_screen = _explode  # type: ignore[method-assign]
        assert await app._tool_hook(_ctx("write", path="x.md", content="hi")) is None
        assert app._ask_permission is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key,expected",
    [("enter", "approve"), ("a", "always"), ("escape", "reject"), ("r", "reject")],
)
async def test_permission_modal_keybindings(key, expected):
    from textual.app import App, ComposeResult
    from textual.widgets import Static

    from minima_harness.tui.overlays import PermissionRequest

    class _App(App):
        result: dict | None = None

        def compose(self) -> ComposeResult:
            yield Static()

        def on_mount(self) -> None:
            self.push_screen(
                PermissionRequest("write", "+# new file", "notes.md"),
                callback=lambda r: setattr(self, "result", r),
            )

    app = _App()
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.screen.query_one("#perm-card").border_title == "permission"
        await pilot.press(key)
        await pilot.pause()
    assert app.result == {"action": expected}


@pytest.mark.asyncio
async def test_yolo_command_toggles_permission():
    app = _app()
    async with app.run_test() as pilot:
        assert app._ask_permission is True
        await app._dispatch_command("yolo", "")
        await pilot.pause()
        assert app._ask_permission is False
        await app._dispatch_command("yolo", "off")  # off = permissions back on
        await pilot.pause()
        assert app._ask_permission is True
