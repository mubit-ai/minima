from __future__ import annotations

import importlib.util
import logging
from collections.abc import Callable
from pathlib import Path

from minima_harness.tui.commands import Command
from minima_harness.tui.customize import GLOBAL_DIR

_log = logging.getLogger("minima_harness.tui.extensions")

# Extension event-hook keys (the fanout maps AgentEvent types onto these).
HOOK_KEYS = ("text", "tool_start", "tool_end", "turn", "finish")


class ExtensionAPI:
    """Surface an extension uses to add tools, commands, and event hooks.

    A Python extension is a module in ``~/.minima-harness/extensions/`` (or
    ``.pi/extensions/``) that defines ``register(api: ExtensionAPI)``.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.tools: list = []
        self.commands: dict[str, Command] = {}
        self.hooks: dict[str, list[Callable]] = {k: [] for k in HOOK_KEYS}

    def tool(self, tool) -> None:  # noqa: ANN001
        """Register an :class:`AgentTool`."""
        self.tools.append(tool)

    def command(self, name: str, *, description: str = "") -> Callable:
        """Register an async slash-command handler ``async def(app, args) -> str|None``."""

        def deco(fn: Callable) -> Callable:
            self.commands[name] = Command(name=name, handler=fn, description=description)
            return fn

        return deco

    def on(self, event_key: str) -> Callable:
        """Register an event hook (``text``/``tool_start``/``tool_end``/``turn``/``finish``)."""

        def deco(fn: Callable) -> Callable:
            self.hooks.setdefault(event_key, []).append(fn)
            return fn

        return deco


def load_extensions(cwd: Path) -> list[ExtensionAPI]:
    """Discover and load Python extension modules from the extensions dirs."""
    dirs = [GLOBAL_DIR / "extensions", cwd / ".pi" / "extensions"]
    apis: list[ExtensionAPI] = []
    seen: set[str] = set()
    for base in dirs:
        if not base.is_dir():
            continue
        for f in sorted(base.glob("*.py")):
            if f.name.startswith("_") or f.stem in seen:
                continue
            api = ExtensionAPI(f.stem)
            try:
                spec = importlib.util.spec_from_file_location(f"minima_harness_ext.{f.stem}", f)
                if spec is None or spec.loader is None:
                    continue
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                register = getattr(mod, "register", None)
                if register is None:
                    continue
                register(api)
            except Exception:  # noqa: BLE001 - one broken extension must not break startup
                _log.warning("extension_load_failed: %s", f, exc_info=True)
                continue
            seen.add(f.stem)
            apis.append(api)
    return apis
