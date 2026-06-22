from __future__ import annotations

from textual.events import Key
from textual.message import Message
from textual.widgets import TextArea

_NEWLINE_KEYS = frozenset({"shift+enter", "ctrl+enter"})


class Editor(TextArea):
    """Multi-line editor with /-command autocomplete.

    Enter submits (or steers while the agent runs — decided by the app); Shift/Ctrl+Enter
    inserts a newline; Alt+Enter queues a follow-up. Text changes flow out via TextArea's
    built-in ``Changed`` message so the app can drive a command popup; Tab on a ``/``-prefixed
    line requests completion.
    """

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class FollowUp(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class CompleteRequested(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    def __init__(self) -> None:
        super().__init__(id="editor", soft_wrap=True, show_line_numbers=False)

    def on_key(self, event: Key) -> None:
        if event.key == "tab" and self.text.startswith("/"):
            event.prevent_default()
            event.stop()
            self.post_message(self.CompleteRequested(self.text))
            return
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
