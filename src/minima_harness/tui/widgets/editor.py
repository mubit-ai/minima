from __future__ import annotations

from textual.events import Key
from textual.message import Message
from textual.widgets import TextArea

from minima_harness.tui.history import History

_NEWLINE_KEYS = frozenset({"shift+enter", "ctrl+enter"})


class Editor(TextArea):
    """Multi-line editor with /-command autocomplete.

    Enter submits (or queues a follow-up while the agent runs — decided by the app);
    Shift/Ctrl+Enter inserts a newline; Alt+Enter steers the running turn. Text changes flow
    out via TextArea's
    built-in ``Changed`` message so the app can drive a command popup; Tab on a ``/``-prefixed
    line requests completion.
    """

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class Steer(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class CompleteRequested(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class CycleThinking(Message):
        def __init__(self) -> None:
            super().__init__()

    def __init__(self) -> None:
        super().__init__(id="editor", soft_wrap=True, show_line_numbers=False)
        self.border_title = "prompt"  # titled accent border frames the input as the focus target
        self.prompt_history: History | None = None  # set by the app for Up/Down recall

    def on_key(self, event: Key) -> None:
        if event.key in ("up", "down") and self.prompt_history is not None:
            row = self.cursor_location[0]
            on_edge = (event.key == "up" and row == 0) or (
                event.key == "down" and row >= self.text.count("\n")
            )
            if "\n" not in self.text or on_edge:
                entry = (
                    self.prompt_history.prev() if event.key == "up" else self.prompt_history.next()
                )
                if entry is None:
                    return  # nothing to recall / already at the new position
                event.prevent_default()
                event.stop()
                self.text = entry
                self.move_cursor((0, len(entry)))
                return
        if event.key == "tab" and self.text.startswith("/"):
            event.prevent_default()
            event.stop()
            self.post_message(self.CompleteRequested(self.text))
            return
        if event.key == "shift+tab":
            event.prevent_default()
            event.stop()
            self.post_message(self.CycleThinking())
            return
        if event.key == "enter":
            event.prevent_default()
            event.stop()
            self.post_message(self.Submitted(self.text))
        elif event.key == "alt+enter":
            event.prevent_default()
            event.stop()
            self.post_message(self.Steer(self.text))
        elif event.key in _NEWLINE_KEYS:
            event.prevent_default()
            event.stop()
            self.insert("\n")
