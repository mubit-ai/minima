from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

Handler = Callable[[Any, str], Awaitable[str | None]]


@dataclass(slots=True)
class Command:
    name: str
    handler: Handler
    description: str = ""


@dataclass(slots=True)
class CommandRegistry:
    _cmds: dict[str, Command] = field(default_factory=dict)

    def register(self, name: str, *, description: str = "") -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            self._cmds[name] = Command(name=name, handler=fn, description=description)
            return fn

        return deco

    def get(self, name: str) -> Command | None:
        return self._cmds.get(name)

    def all(self) -> list[Command]:
        return sorted(self._cmds.values(), key=lambda c: c.name)

    def help_text(self) -> str:
        width = max((len(c.name) for c in self._cmds.values()), default=4)
        lines = [f"  /{c.name.ljust(width)}  {c.description}".rstrip() for c in self.all()]
        return "Commands:\n" + "\n".join(lines)
