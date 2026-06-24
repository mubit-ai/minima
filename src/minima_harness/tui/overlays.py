from __future__ import annotations

from pathlib import Path
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Input, OptionList, Static, TextArea, Tree
from textual.widgets.option_list import Option

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.store import SessionSummary
from minima_harness.tui import config_store
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


class RoutingConfirm(ModalScreen[dict | None]):
    """Modal routing confirmation: shows ranked candidates with predicted success /
    estimated cost tradeoffs. Enter selects, 'p' pins, Esc cancels."""

    BINDINGS = [
        ("escape", "cancel"),
        Binding("p", "pin", "Pin", priority=True),
    ]

    def __init__(self, routing: Any) -> None:
        super().__init__()
        self._routing = routing

    def compose(self) -> ComposeResult:
        chosen = self._routing.chosen_model_id or self._routing.model.id
        yield Static(
            Text(
                f"Recommended: {chosen} · basis {self._routing.decision_basis} · "
                f"confidence {self._routing.confidence:.0%}\n↑↓ navigate · Enter select · "
                f"p pin · Esc cancel",
                style="bold",
            )
        )
        ranked = self._routing.ranked or []
        cheapest = min((r.est_cost_usd for r in ranked), default=0.0)
        options = []
        for r in ranked:
            mark = "●" if r.model_id == self._routing.chosen_model_id else "○"
            delta = r.est_cost_usd - cheapest
            dstr = "cheapest" if delta <= 0 else f"+${delta:.4f}"
            label = (
                f"{mark} {r.model_id}  {r.provider}  {r.predicted_success:.0%}  "
                f"${r.est_cost_usd:.4f}  {dstr}"
            )
            options.append(Option(label, id=r.model_id))
        yield OptionList(*options)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss({"action": "select", "model_id": event.option.id})

    def action_pin(self) -> None:
        ol = self.query_one(OptionList)
        if ol.highlighted is not None:
            opt = ol.get_option_at_index(ol.highlighted)
            self.dismiss({"action": "pin", "model_id": opt.id})

    def action_cancel(self) -> None:
        self.dismiss({"action": "cancel", "model_id": None})


class DiffApproval(ModalScreen[dict | None]):
    """Modal diff review for a mutating tool. Enter/a approve, Esc/r reject.

    Returns {"action": "approve"|"reject"}. A reject blocks the tool and feeds a
    ground-truth negative signal back to Minima.
    """

    BINDINGS = [
        Binding("enter", "approve", "Approve", priority=True),
        Binding("a", "approve", "Approve", priority=True),
        Binding("escape", "reject", "Reject", priority=True),
        Binding("r", "reject", "Reject", priority=True),
    ]

    def __init__(self, tool_name: str, diff_text: str, target: str = "") -> None:
        super().__init__()
        self._name = tool_name
        self._diff = diff_text
        self._target = target

    def compose(self) -> ComposeResult:
        head = f"{self._name} {self._target}".strip()
        yield Static(
            Text(f"review: {head}  ·  Enter/a approve · Esc/r reject", style="bold"),
        )
        yield TextArea(
            self._diff, id="diff-view", read_only=True, soft_wrap=False, show_line_numbers=False
        )

    def on_mount(self) -> None:
        self.query_one("#diff-view", TextArea).focus()

    def action_approve(self) -> None:
        self.dismiss({"action": "approve"})

    def action_reject(self) -> None:
        self.dismiss({"action": "reject"})


class ConfigOverlay(ModalScreen[dict | None]):
    """Edit stored credentials, grouped into sections. Ctrl+S saves, Esc cancels.

    Returns ``{key: value}`` for fields that were changed (already persisted to the store),
    or ``None`` on cancel. Secret inputs are password-masked and show the masked *current*
    value as a placeholder — the real secret is never pre-filled into an editable field.
    Leaving a field blank keeps its current value.
    """

    BINDINGS = [
        Binding("ctrl+s", "save", "Save", priority=True),
        ("escape", "cancel"),
    ]

    def compose(self) -> ComposeResult:
        backend = config_store.backend_name()
        with Vertical(id="config-card"):
            yield Static(
                Text(
                    f"blank keeps current · Ctrl+S save · Esc cancel · secrets → {backend}",
                ),
                id="config-hint",
            )
            with VerticalScroll(id="config-body"):
                for section in config_store.SECTIONS:
                    yield Static(Text(section.title), classes="cfg-section")
                    yield Static(Text(section.note), classes="cfg-note")
                    for f in section.fields:
                        cur = config_store.get(f.key) or ""
                        if cur:
                            placeholder = config_store.mask(cur) if f.secret else cur
                        else:
                            placeholder = f.default or "(unset)"
                        tag = "   optional" if f.optional else ""
                        yield Static(Text(f"{f.key}{tag}"), classes="cfg-key")
                        yield Input(placeholder=placeholder, password=f.secret, id=f"cfg-{f.key}")

    def on_mount(self) -> None:
        self.query_one("#config-card").border_title = "config"
        inputs = self.query(Input)
        if inputs:
            inputs.first().focus()

    def action_save(self) -> None:
        changes: dict[str, str] = {}
        for f in config_store.all_fields():
            val = self.query_one(f"#cfg-{f.key}", Input).value.strip()
            if val:  # only non-empty entries change anything
                config_store.set_value(f.key, val)
                changes[f.key] = val
        self.dismiss(changes)

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
