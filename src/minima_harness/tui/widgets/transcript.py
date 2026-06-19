from __future__ import annotations

from rich.text import Text
from textual.widgets import RichLog

from minima_harness.tui.theme import get_theme


class Transcript(RichLog):
    """A scrolling transcript of user prompts, tool calls, and assistant answers."""

    def __init__(self) -> None:
        super().__init__(markup=True, wrap=True, auto_scroll=True)
        self._theme = get_theme("dark")

    def add_user(self, text: str) -> None:
        self.write(Text(f"▸ {text}", style=self._theme["user"]))

    def add_assistant(self, text: str) -> None:
        if text:
            self.write(Text(text, style=self._theme["assistant"]))

    def add_tool(self, name: str, args_repr: str = "") -> None:
        line = Text(f"◆ {name}", style=self._theme["tool"])
        if args_repr:
            line.append(f"  {args_repr}", style=self._theme["muted"])
        self.write(line)

    def add_tool_result(self, summary: str, is_error: bool) -> None:
        style = self._theme["warning"] if is_error else self._theme["muted"]
        self.write(Text(f"   → {summary}", style=style))

    def add_error(self, message: str) -> None:
        self.write(Text(f"✗ {message}", style=self._theme["warning"]))

    def add_system(self, text: str) -> None:
        self.write(Text(text, style=self._theme["muted"]))
