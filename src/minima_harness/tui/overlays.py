from __future__ import annotations

from pathlib import Path

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import OptionList, Tree
from textual.widgets.option_list import Option

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.store import SessionSummary
from minima_harness.tui.commands import Command


class ModelPicker(ModalScreen[str | None]):
    """Modal model picker. Returns the chosen model id, or None on cancel.

    Selecting a model pins it as the only candidate so Minima routes to it.
    """

    BINDINGS = [("escape", "cancel")]

    def __init__(self, candidates: list[str], current: str | None) -> None:
        super().__init__()
        self._candidates = candidates
        self._current = current

    def compose(self) -> ComposeResult:
        options = [
            Option(f"{c}  ◂ current" if c == self._current else c, id=c) for c in self._candidates
        ]
        yield OptionList(*options)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id)

    def action_cancel(self) -> None:
        self.dismiss(None)


class TreePicker(ModalScreen[None]):
    """Modal session-tree viewer (read-only for now; branching comes later)."""

    BINDINGS = [("escape", "cancel"), ("enter", "cancel")]

    def __init__(self, store: SessionStore) -> None:
        super().__init__()
        self._store = store

    def compose(self) -> ComposeResult:
        tree: Tree[str] = Tree("session")
        cm = self._store.children_map()
        entries = {e.id: e for e in self._store.entries}

        def build(node, parent_id: str | None) -> None:
            for cid in cm.get(parent_id, []):
                entry = entries.get(cid)
                label = f"{cid[:6]} {entry.type.value}" if entry else cid[:6]
                child = node.add(label)
                build(child, cid)

        build(tree.root, None)
        tree.show_root = True
        yield tree

    def action_cancel(self) -> None:
        self.dismiss(None)


class SessionPicker(ModalScreen[str | None]):
    """Modal session-history picker. Returns the chosen session file path, or None."""

    BINDINGS = [("escape", "cancel")]

    def __init__(self, summaries: list[SessionSummary]) -> None:
        super().__init__()
        self._summaries = summaries

    def compose(self) -> ComposeResult:
        if not self._summaries:
            yield OptionList(Option("(no saved sessions)", id=""))
            return
        options = [
            Option(f"{s.session_id[:8]}  ·  {s.n_entries} entries", id=str(s.path))
            for s in self._summaries
        ]
        yield OptionList(*options)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id or None)

    def action_cancel(self) -> None:
        self.dismiss(None)


def list_sessions_for_picker(cwd: Path | None) -> list[SessionSummary]:
    return SessionManager().list_sessions(cwd) if cwd is not None else []


class CommandPicker(ModalScreen[str | None]):
    """Modal command palette. Returns the chosen command name, or None on cancel."""

    BINDINGS = [("escape", "cancel")]

    def __init__(self, commands: list[Command]) -> None:
        super().__init__()
        self._commands = commands

    def compose(self) -> ComposeResult:
        if not self._commands:
            yield OptionList(Option("(no commands)", id=""))
            return
        options = [Option(f"{c.name}  {c.description}".rstrip(), id=c.name) for c in self._commands]
        yield OptionList(*options)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id or None)

    def action_cancel(self) -> None:
        self.dismiss(None)
