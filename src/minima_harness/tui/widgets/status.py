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
        self._idle_text: Text | str = ""
        self._timer = None

    def on_mount(self) -> None:
        # The spinner timer runs ONLY while the agent is busy — paused at idle so the event
        # loop (and the terminal) can truly sleep instead of waking 10x/s for a no-op tick.
        self._timer = self.set_interval(0.1, self._tick, pause=True)

    def _tick(self) -> None:
        self._frame = (self._frame + 1) % len(_FRAMES)
        self._display()

    def set_state(self, state: str) -> None:
        # Idempotent: the streaming path calls this on every token delta with the same state,
        # which would otherwise repaint the footer per token (50-100x/s) and spin fans. Only
        # (re)render and toggle the spinner timer when the state actually changes.
        if state == self._state:
            return
        self._state = state
        if self._timer is not None:
            if state == "idle":
                self._timer.pause()
            else:
                self._frame = 0
                self._timer.resume()
        self._display()

    def set_idle_text(self, text: Text | str) -> None:
        # Accept a rich Text so the footer's per-segment colours survive (don't flatten).
        self._idle_text = text
        if self._state == "idle":
            self._display()

    def _display(self) -> None:
        t = get_theme(current_theme())
        if self._state == "idle":
            self.update(self._idle_text or "")
        else:
            self.update(Text(f"{_FRAMES[self._frame]} {self._state}…", style=t["accent"]))
