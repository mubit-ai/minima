from __future__ import annotations

from textual.events import Key
from textual.message import Message
from textual.widgets import TextArea

_NEWLINE_KEYS = frozenset({"shift+enter", "ctrl+enter"})


class Editor(TextArea):
    """Multi-line editor.

    Enter submits (or steers if the agent is running — decided by the app);
    Shift/Ctrl+Enter inserts a newline; Alt+Enter queues a follow-up.
    """

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class FollowUp(Message):
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
        elif event.key == "alt+enter":
            event.prevent_default()
            event.stop()
            self.post_message(self.FollowUp(self.text))
        elif event.key in _NEWLINE_KEYS:
            event.prevent_default()
            event.stop()
            self.insert("\n")
