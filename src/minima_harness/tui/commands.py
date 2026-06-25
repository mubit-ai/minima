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
    hidden: bool = False  # dispatchable via get(), but omitted from listings (aliases)


@dataclass(slots=True)
class CommandRegistry:
    _cmds: dict[str, Command] = field(default_factory=dict)

    def register(
        self, name: str, *, description: str = "", hidden: bool = False
    ) -> Callable[[Handler], Handler]:
        def deco(fn: Handler) -> Handler:
            self._cmds[name] = Command(
                name=name, handler=fn, description=description, hidden=hidden
            )
            return fn

        return deco

    def get(self, name: str) -> Command | None:
        return self._cmds.get(name)

    def add_command(self, cmd: Command) -> None:
        self._cmds[cmd.name] = cmd

    def remove_command(self, name: str) -> None:
        self._cmds.pop(name, None)

    def all(self) -> list[Command]:
        # Hidden aliases stay dispatchable (via get) but out of the palette/help/completion.
        return sorted((c for c in self._cmds.values() if not c.hidden), key=lambda c: c.name)

    def help_text(self) -> str:
        width = max((len(c.name) for c in self._cmds.values()), default=4)
        lines = [f"  /{c.name.ljust(width)}  {c.description}".rstrip() for c in self.all()]
        return "Commands:\n" + "\n".join(lines)
