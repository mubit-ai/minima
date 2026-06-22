from __future__ import annotations

from rich.text import Text
from textual.widgets import Static

from minima_harness.tui.theme import current_theme, get_theme

_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


class StatusBar(Static):
    """Bottom loader/status bar: an animated spinner while the agent runs
    (routing / thinking / working), and a static status line when idle."""

    def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        super().__init__(*args, **kwargs)
        self._state = "idle"  # idle | routing | thinking | working
        self._frame = 0
        self._idle_text = ""

    def on_mount(self) -> None:
        self.set_interval(0.1, self._tick)

    def _tick(self) -> None:
        if self._state == "idle":
            return
        self._frame = (self._frame + 1) % len(_FRAMES)
        self._display()

    def set_state(self, state: str) -> None:
        self._state = state
        self._display()

    def set_idle_text(self, text: str) -> None:
        self._idle_text = text
        if self._state == "idle":
            self._display()

    def _display(self) -> None:
        t = get_theme(current_theme())
        if self._state == "idle":
            self.update(Text(self._idle_text, style=t["muted"]))
        else:
            self.update(Text(f"{_FRAMES[self._frame]} {self._state}…", style=t["accent"]))
