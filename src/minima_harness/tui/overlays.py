from __future__ import annotations

from pathlib import Path

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import OptionList, Static, TextArea, Tree
from textual.widgets.option_list import Option

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.store import SessionSummary
from minima_harness.tui.commands import Command


class ModelPicker(ModalScreen[str | None]):
    """Modal model picker. Returns the chosen model id, or None on cancel.

    Selecting a model pins it as the only candidate so Minima routes to it.
    """

    BINDINGS = [("escape", "cancel")]

    def __init__(
        self,
        candidates: list[str],
        *,
        active: str | None = None,
        basis: str | None = None,
        pinned: str | None = None,
        providers: dict[str, str] | None = None,
    ) -> None:
        super().__init__()
        self._candidates = candidates
        self._active = active
        self._basis = basis
        self._pinned = pinned
        self._providers = providers or {}

    def compose(self) -> ComposeResult:
        yield Static(
            Text(
                f"active: {self._active or '—'} · basis: {self._basis or '-'} "
                f"· pinned: {self._pinned or 'none'}",
                style="bold",
            )
        )
        options = []
        for c in self._candidates:
            mark = "●" if c == self._active else "○"
            prov = self._providers.get(c, "")
            last = "  ◂ last" if c == self._active else ""
            options.append(Option(f"{mark} {c}  {prov}{last}".rstrip(), id=c))
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


class PromptInspector(ModalScreen[dict | None]):
    """Edit the effective system prompt. Ctrl+P saves to Mubit (project), Ctrl+S to the
    session override, Esc cancels. Returns {"action", "content"} or None."""

    BINDINGS = [
        Binding("ctrl+p", "save_project", "Project", priority=True),
        Binding("ctrl+s", "save_session", "Session", priority=True),
        ("escape", "cancel"),
    ]

    def __init__(self, prompt_text: str, tokens: dict[str, int]) -> None:
        super().__init__()
        self._prompt = prompt_text
        self._tokens = tokens

    def compose(self) -> ComposeResult:
        t = self._tokens
        yield Static(
            Text(
                f"system ~{t['system']} · history ~{t['history']} · total ~{t['total']} "
                "tokens (est)  |  Ctrl+P save project (Mubit) · Ctrl+S save session · Esc cancel",
                style="dim",
            )
        )
        yield TextArea(self._prompt, id="prompt-editor", soft_wrap=True, show_line_numbers=False)

    def on_mount(self) -> None:
        self.query_one("#prompt-editor", TextArea).focus()

    def action_save_project(self) -> None:
        text = self.query_one("#prompt-editor", TextArea).text
        self.dismiss({"action": "project", "content": text})

    def action_save_session(self) -> None:
        text = self.query_one("#prompt-editor", TextArea).text
        self.dismiss({"action": "session", "content": text})

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
