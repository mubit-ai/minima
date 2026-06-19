from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import OptionList, Tree
from textual.widgets.option_list import Option

from minima_harness.session import SessionStore


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
