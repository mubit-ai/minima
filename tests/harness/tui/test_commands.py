from __future__ import annotations

from minima_harness.tui.commands import CommandRegistry


async def test_register_and_lookup():
    reg = CommandRegistry()

    @reg.register("ping")
    async def _ping(app, args):
        return f"pong {args}".strip()

    assert reg.get("ping") is not None
    out = await reg.get("ping").handler(None, "x")
    assert out == "pong x"


def test_help_lists_all_commands():
    reg = CommandRegistry()

    @reg.register("quit", description="exit")
    async def _q(app, args):
        return None

    @reg.register("model", description="show model")
    async def _m(app, args):
        return None

    names = [c.name for c in reg.all()]
    assert {"quit", "model"} <= set(names)
    assert "/quit" in reg.help_text() and "/model" in reg.help_text()


async def test_unknown_command_returns_none():
    reg = CommandRegistry()
    assert reg.get("nope") is None
