from __future__ import annotations

from textual.events import Key
from textual.message import Message
from textual.widgets import TextArea

_NEWLINE_KEYS = frozenset({"shift+enter", "ctrl+enter", "alt+enter"})


class Editor(TextArea):
    """Multi-line editor. Enter submits; Shift/Ctrl/Alt+Enter inserts a newline."""

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    def __init__(self) -> None:
        super().__init__(id="editor", soft_wrap=True, show_line_numbers=False)

    def on_key(self, event: Key) -> None:
        if event.key == "enter":
            event.prevent_default()
            event.stop()
            self.post_message(self.Submitted(self.text))
        elif event.key in _NEWLINE_KEYS:
            event.prevent_default()
            event.stop()
            self.insert("\n")
