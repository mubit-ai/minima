from __future__ import annotations

from pathlib import Path
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Collapsible, Input, OptionList, Static, TextArea, Tree
from textual.widgets.option_list import Option

from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.store import SessionSummary
from minima_harness.tui import config_store
from minima_harness.tui.commands import Command


class ModelPicker(ModalScreen[str | None]):
    """Modal model picker. Returns the chosen model id, or None on cancel.

    Selecting a model pins it as the only candidate so Minima routes to it. The first entry is
    always ``AUTO`` — selecting it releases any pin and hands routing back to Minima.
    """

    AUTO = "__auto__"  # sentinel id for the "let Minima route (unpin)" entry

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
        options = []
        # Always offer "auto" first so a pinned model can be released back to Minima routing.
        # It is the active row when nothing is pinned; otherwise it is the unpin affordance.
        auto_mark = "○" if self._pinned else "●"
        options.append(Option(f"{auto_mark} auto  ◂ let Minima route (unpin)", id=self.AUTO))
        for c in self._candidates:
            mark = "●" if c == self._pinned else ("◦" if c == self._active else "○")
            prov = self._providers.get(c, "")
            tag = "  ◂ pinned" if c == self._pinned else ("  ◂ last" if c == self._active else "")
            options.append(Option(f"{mark} {c}  {prov}{tag}".rstrip(), id=c))
        yield OptionList(*options)

    def on_mount(self) -> None:
        ol = self.query_one(OptionList)
        ol.border_title = "model"
        ol.border_subtitle = f"basis {self._basis or '-'} · pinned {self._pinned or 'none'}"

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

    def on_mount(self) -> None:
        self.query_one(Tree).border_title = "session tree"

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

    def on_mount(self) -> None:
        self.query_one(OptionList).border_title = "resume session"

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


class LayeredPromptInspector(ModalScreen[dict | None]):
    """Transparent, per-layer view of the assembled system prompt + edit control.

    Each layer (base, project context, session override, Mubit lessons, …) renders in its
    own collapsible with a token count, so the user can see exactly what's sent and which
    layer costs what. Two editable areas let them control the layers they own: Ctrl+P saves
    the system prompt to Mubit (project, versioned), Ctrl+S saves the session override. Esc
    cancels. Returns the same ``{"action","content"}`` dict as PromptInspector so
    ``_apply_prompt_edit`` is reused unchanged.
    """

    BINDINGS = [
        Binding("ctrl+p", "save_project", "Save→Mubit", priority=True),
        Binding("ctrl+s", "save_session", "Save session", priority=True),
        ("escape", "cancel"),
    ]

    def __init__(
        self, layers: list[Any], project_text: str, session_text: str, breakdown: dict
    ) -> None:
        super().__init__()
        self._layers = layers
        self._project_text = project_text
        self._session_text = session_text
        self._breakdown = breakdown

    def compose(self) -> ComposeResult:
        b = self._breakdown
        with Vertical(id="prompt-card"):
            yield Static(
                Text(
                    f"total ~{b['total']} tok · system ~{b['system']} · history ~{b['history']}"
                    "   ·   Ctrl+P save system→Mubit · Ctrl+S save session · Esc cancel",
                ),
                id="prompt-hint",
            )
            with VerticalScroll(id="prompt-body"):
                for layer in self._layers:
                    title = f"{layer.name}  ~{layer.tokens} tok  ({layer.source})"
                    with Collapsible(title=title, collapsed=True):
                        yield TextArea(
                            layer.text, read_only=True, soft_wrap=True, classes="layer-view"
                        )
                with Collapsible(title="✎ system prompt → Mubit (project)", collapsed=False):
                    yield TextArea(
                        self._project_text, id="edit-project", soft_wrap=True,
                        show_line_numbers=False,
                    )
                with Collapsible(title="✎ session override → session", collapsed=False):
                    yield TextArea(
                        self._session_text, id="edit-session", soft_wrap=True,
                        show_line_numbers=False,
                    )

    def on_mount(self) -> None:
        self.query_one("#prompt-card").border_title = "prompt"
        self.query_one("#edit-project", TextArea).focus()

    def action_save_project(self) -> None:
        text = self.query_one("#edit-project", TextArea).text
        self.dismiss({"action": "project", "content": text})

    def action_save_session(self) -> None:
        text = self.query_one("#edit-session", TextArea).text
        self.dismiss({"action": "session", "content": text})

    def action_cancel(self) -> None:
        self.dismiss(None)


class PromptOptimizationOverlay(ModalScreen[dict | None]):
    """Preview a proposed system-prompt optimization: current → proposed tokens, the
    rationale, and the new prompt. Ctrl+S applies it (→ Mubit project, versioned), Esc cancels.
    Returns ``{"action": "apply", "content": str}`` or None."""

    BINDINGS = [
        Binding("ctrl+s", "apply", "Apply", priority=True),
        ("escape", "cancel"),
    ]

    def __init__(self, opt: Any) -> None:
        super().__init__()
        self._opt = opt

    def compose(self) -> ComposeResult:
        o = self._opt
        if o.est_savings > 0:
            change = f"save {o.est_savings} tok"
        elif o.est_savings < 0:
            change = f"grow {abs(o.est_savings)} tok (quality over size)"
        else:
            change = "no token change"
        with Vertical(id="opt-card"):
            yield Static(
                Text(
                    f"{o.source} · ~{o.current_tokens} → ~{o.new_tokens} tok · {change}"
                    "   ·   Ctrl+S apply · Esc cancel",
                    style="bold",
                ),
                id="opt-head",
            )
            if o.rationale:
                yield Static(Text(o.rationale), id="opt-reason")
            yield TextArea(o.new_prompt, read_only=True, soft_wrap=True, id="opt-view")

    def on_mount(self) -> None:
        self.query_one("#opt-card").border_title = "optimize"

    def action_apply(self) -> None:
        self.dismiss({"action": "apply", "content": self._opt.new_prompt})

    def action_cancel(self) -> None:
        self.dismiss(None)


class RoutingConfirm(ModalScreen[dict | None]):
    """The routing decision card: each candidate framed as cost (with range) / speed /
    predictability, the recommended pick's reasoning, and ROI vs the next-pricier model.
    ↑↓ navigate · Enter select · p pin · Esc cancel. Returns {"action","model_id"}."""

    BINDINGS = [
        ("escape", "cancel"),
        Binding("p", "pin", "Pin", priority=True),
    ]

    def __init__(self, routing: Any, reason: str = "") -> None:
        super().__init__()
        self._routing = routing
        self._reason = reason

    def compose(self) -> ComposeResult:
        r = self._routing
        chosen_id = r.chosen_model_id or r.model.id
        with Vertical(id="route-card"):
            yield Static(
                Text(
                    f"recommended {chosen_id} · {r.decision_basis} · conf {r.confidence:.0%}",
                    style="bold",
                ),
                id="route-head",
            )
            if self._reason:
                yield Static(Text(self._reason), id="route-reason")
            yield Static(
                Text("cost (range) · speed · predictability   —   ↑↓ Enter select · p pin · Esc"),
                id="route-hint",
            )
            from minima_harness.ai.provider_catalog import provider_key_present

            ranked = r.ranked or []
            cheapest = min((c.est_cost_usd for c in ranked), default=0.0)
            options = []
            for c in ranked:
                mark = "●" if c.model_id == chosen_id else "○"
                hw = c.success_interval_width / 2.0
                if c.est_cost_low is not None and c.est_cost_high is not None:
                    cost = f"${c.est_cost_usd:.4f} (${c.est_cost_low:.4f}–${c.est_cost_high:.4f})"
                else:
                    cost = f"${c.est_cost_usd:.4f} (no range)"
                lat = f"~{c.est_latency_ms:.0f}ms" if c.est_latency_ms else "~?ms"
                delta = c.est_cost_usd - cheapest
                dstr = "cheapest" if delta <= 0 else f"+${delta:.4f}"
                # Flag a pick the user can't actually run (no provider key) so it's obvious why
                # selecting it would fail — the run itself then reports the exact auth error.
                nokey = "" if provider_key_present(c.provider) else "  ⚠ no key"
                label = (
                    f"{mark} {c.model_id}  succ {c.predicted_success:.0%}±{hw:.0%}  "
                    f"{cost}  {lat}  {dstr}{nokey}"
                )
                options.append(Option(label, id=c.model_id))
            yield OptionList(*options)

    def on_mount(self) -> None:
        self.query_one("#route-card").border_title = "routing"

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


class GoalsOverlay(ModalScreen[None]):
    """Read-only view of the active goal + its task checklist. Esc/Enter closes.

    The model maintains the task list via the ``tasks`` tool; the user sets/clears the goal with
    ``/goals set <title>`` / ``/goals clear``.
    """

    BINDINGS = [("escape", "cancel"), ("enter", "cancel")]

    _MARK = {"completed": "✓", "in_progress": "▸", "blocked": "✗", "pending": "○"}

    def __init__(self, goal: Any) -> None:
        super().__init__()
        self._goal = goal

    def compose(self) -> ComposeResult:
        with Vertical(id="goals-card"):
            g = self._goal
            if g is None or (not g.title and not g.tasks):
                hint = "no open ledger — set one with  /ledger set <title>"
                yield Static(Text(hint, style="dim"))
                return
            done, total = g.progress()
            head = f"{g.title}   ·   {done}/{total} done" if g.title else f"{done}/{total} done"
            yield Static(Text(head, style="bold"), id="goals-head")
            if g.budget_usd:
                yield Static(
                    Text(f"budget ${g.budget_usd:.4f} · spent ${g.spent_usd():.4f}", style="dim"),
                    id="goals-budget",
                )
            with VerticalScroll(id="goals-body"):
                for t in g.tasks:
                    yield Static(Text(f"  {self._MARK.get(t.status, '○')} {t.content}"))

    def on_mount(self) -> None:
        self.query_one("#goals-card").border_title = "ledger"

    def action_cancel(self) -> None:
        self.dismiss(None)


class PermissionRequest(ModalScreen[dict | None]):
    """Approve a sensitive tool call (write/edit/bash) before it runs.

    Enter approves once · ``a`` always-allows this tool for the session · Esc/``r`` rejects.
    The body previews exactly what will happen (a diff for write/edit, the command for bash).
    Returns ``{"action": "approve"|"always"|"reject"}``. A reject blocks the tool and feeds a
    ground-truth negative back to Minima.
    """

    BINDINGS = [
        Binding("enter", "approve", "Approve", priority=True),
        Binding("a", "always", "Always", priority=True),
        Binding("escape", "reject", "Reject", priority=True),
        Binding("r", "reject", "Reject", priority=True),
    ]

    def __init__(self, tool_name: str, preview: str, target: str = "") -> None:
        super().__init__()
        self._name = tool_name
        self._preview = preview
        self._target = target

    def compose(self) -> ComposeResult:
        head = f"{self._name}  {self._target}".strip()
        with Vertical(id="perm-card"):
            yield Static(Text(head, style="bold"), id="perm-head")
            yield Static(
                Text("Enter approve · a always-allow · Esc reject", style="dim"), id="perm-hint"
            )
            yield TextArea(
                self._preview, id="perm-view", read_only=True, soft_wrap=False,
                show_line_numbers=False,
            )

    def on_mount(self) -> None:
        self.query_one("#perm-card").border_title = "permission"
        self.query_one("#perm-view", TextArea).focus()

    def action_approve(self) -> None:
        self.dismiss({"action": "approve"})

    def action_always(self) -> None:
        self.dismiss({"action": "always"})

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
                Text("Enter your keys — blank keeps the current value. Any one provider works."),
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
                yield Button("Save", id="cfg-save", variant="primary")
            # Always-visible footer (outside the scroll) so the save affordance never
            # scrolls out of sight while filling lower fields.
            yield Static(
                Text(f"Enter ▸ next field (lands on Save) · Ctrl+S ▸ save · Esc ▸ cancel  ·  "
                     f"secrets → {backend}"),
                id="config-foot",
            )

    def on_mount(self) -> None:
        self.query_one("#config-card").border_title = "config"
        inputs = self.query(Input)
        if inputs:
            inputs.first().focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        # Enter walks through the fields and lands on the Save button, so a user can fill
        # every key with Enter and the final Enter (on Save) commits — no Ctrl+S needed.
        event.stop()
        self.focus_next()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cfg-save":
            self.action_save()

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

    def on_mount(self) -> None:
        self.query_one(OptionList).border_title = "commands"

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(event.option.id or None)

    def action_cancel(self) -> None:
        self.dismiss(None)
