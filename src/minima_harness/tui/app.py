from __future__ import annotations

import inspect
import logging
import os
from functools import partial
from pathlib import Path
from typing import Any

import anyio
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.keys import format_key
from textual.widgets import Footer as TextualFooter
from textual.widgets import Header, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from minima_harness.agent.events import (
    AgentEndEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    TurnEndEvent,
)
from minima_harness.ai.types import AssistantMessage, Message, TextContent
from minima_harness.minima.cache import SemanticCache
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter, CostRow
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.format import EntryType
from minima_harness.tools import default_toolset
from minima_harness.tui import config_store
from minima_harness.tui.analytics import aggregate_sessions, format_stats
from minima_harness.tui.bridge import EventBridge
from minima_harness.tui.clipboard import copy_to_clipboard as _os_clipboard_copy
from minima_harness.tui.commands import CommandRegistry
from minima_harness.tui.compaction import summarize
from minima_harness.tui.context import get_session_override, set_session_override
from minima_harness.tui.editor import parse_submission, run_bash
from minima_harness.tui.extensions import load_extensions
from minima_harness.tui.history import History, append_history, load_history
from minima_harness.tui.mubit import (
    effective_prompt,
    get_prompt,
    init_mubit,
    layer_token_breakdown,
    prompt_layers,
    propose_prompt_optimization,
)
from minima_harness.tui.mubit import (
    recall as mubit_recall,
)
from minima_harness.tui.mubit import (
    set_prompt as mubit_set_prompt,
)
from minima_harness.tui.overlays import (
    CommandPicker,
    ConfigOverlay,
    GoalsOverlay,
    LayeredPromptInspector,
    ModelPicker,
    PermissionRequest,
    PromptOptimizationOverlay,
    RoutingConfirm,
    SessionPicker,
    TreePicker,
)
from minima_harness.tui.widgets.banner import (
    render_banner,
    render_config_banner,
    render_model_error_banner,
    render_notice,
)
from minima_harness.tui.widgets.editor import Editor
from minima_harness.tui.widgets.footer import render_footer
from minima_harness.tui.widgets.messages import ChatLog, MessageBubble
from minima_harness.tui.widgets.status import StatusBar

_log = logging.getLogger("minima_harness.tui.app")

# Tools whose effects are gated behind diff approval when /edits is on.
_MUTATING_TOOLS = frozenset({"edit", "write", "apply_patch"})
# Tools that touch the user's machine/network and so require approval by default.
_SENSITIVE_TOOLS = frozenset({"edit", "write", "bash", "apply_patch"})


class HarnessApp(App):
    BINDINGS = [
        ("ctrl+l", "model", "Model"),
        ("ctrl+r", "cycle_route_mode", "Route"),
        ("escape", "abort", "Abort"),
        ("ctrl+c,ctrl+c", "quit", "Quit"),
        Binding("pageup", "scroll_up", "PgUp", priority=True),
        Binding("pagedown", "scroll_down", "PgDn", priority=True),
    ]
    # Routing autonomy dial (Ctrl+R cycles). "plan" arrives with the Phase-3 plan/act split.
    ROUTE_MODES = ("auto", "confirm")
    CSS = """
    Screen { layout: vertical; }
    #chatlog { height: 1fr; background: $boost; padding: 0 1; }
    #chatlog.empty { align: center middle; }  /* fresh session: center the splash, no void */
    /* The splash must shrink to its content (the banner) so the parent's center-align actually
       centers it — a full-width Static would pin the art to the left edge. */
    #welcome { width: auto; height: auto; }
    #banner { height: auto; padding: 0 1; }
    #editor { height: 6; background: $panel; border: round $accent; padding: 0 1; }
    #status { height: 1; background: $panel; padding: 0 1; color: $text-muted; }
    #cmd-popup {
        display: none; height: auto; max-height: 8;
        background: $panel; padding: 0 1;
    }
    #cmd-popup.visible { display: block; }
    ModelPicker, TreePicker, SessionPicker, CommandPicker { align: center middle; }
    /* All single-widget pickers share the rounded accent card framing (matches #editor /
       ConfigOverlay). The :focus rule must be explicit — OptionList/Tree set a 'tall' focus
       border in their own CSS that out-specifies a plain descendant selector. */
    ModelPicker OptionList, SessionPicker OptionList, CommandPicker OptionList {
        width: 66; height: auto; max-height: 18;
        background: $panel; border: round $accent; padding: 0 1;
    }
    ModelPicker OptionList:focus, SessionPicker OptionList:focus,
    CommandPicker OptionList:focus { border: round $accent; }
    PromptInspector { align: center middle; }
    PromptInspector TextArea { width: 80; height: 20; background: $panel; }
    LayeredPromptInspector { align: center middle; }
    LayeredPromptInspector #prompt-card {
        width: 92; height: auto; max-height: 90%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    LayeredPromptInspector #prompt-hint { color: $text-muted; padding: 0 1 1 1; }
    LayeredPromptInspector #prompt-body { height: auto; max-height: 30; padding: 0 1; }
    LayeredPromptInspector Collapsible { background: $panel; border: none; padding: 0; }
    LayeredPromptInspector TextArea {
        height: 6; background: $boost; border: round $panel-lighten-2;
    }
    LayeredPromptInspector TextArea:focus { border: round $accent; }
    LayeredPromptInspector TextArea.layer-view { height: 5; color: $text-muted; }
    RoutingConfirm { align: center middle; }
    RoutingConfirm #route-card {
        width: 88; height: auto; max-height: 80%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    RoutingConfirm #route-reason { color: $text; padding: 0 1; }
    RoutingConfirm #route-hint { color: $text-muted; padding: 0 1 1 1; }
    RoutingConfirm OptionList {
        height: auto; max-height: 16; background: $panel; border: round $panel-lighten-2;
    }
    RoutingConfirm OptionList:focus { border: round $accent; }
    TreePicker Tree {
        width: 72; height: auto; max-height: 20;
        background: $panel; border: round $accent; padding: 0 1;
    }
    TreePicker Tree:focus { border: round $accent; }
    GoalsOverlay { align: center middle; }
    GoalsOverlay #goals-card {
        width: 84; height: auto; max-height: 80%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    GoalsOverlay #goals-budget { color: $text-muted; padding: 0 1 1 1; }
    GoalsOverlay #goals-body { height: auto; max-height: 22; padding: 0 1; }
    PermissionRequest { align: center middle; }
    PermissionRequest #perm-card {
        width: 92; height: auto; max-height: 85%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    PermissionRequest #perm-hint { color: $text-muted; padding: 0 1 1 1; }
    PermissionRequest #perm-view {
        width: 1fr; height: auto; max-height: 24; background: $boost;
        border: round $panel-lighten-2;
    }
    ConfigOverlay { align: center middle; }
    ConfigOverlay #config-card {
        width: 84; height: auto; max-height: 88%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    ConfigOverlay #config-hint { color: $text-muted; padding: 0 1 1 1; }
    ConfigOverlay #config-body { height: auto; max-height: 26; padding: 0 1; }
    ConfigOverlay #config-foot {
        color: $text-muted; padding: 1 1 0 1; border-top: solid $panel-lighten-2;
    }
    ConfigOverlay .cfg-section { text-style: bold; padding: 1 0 0 0; }
    ConfigOverlay .cfg-note { color: $text-muted; }
    ConfigOverlay .cfg-key { color: $text-muted; padding: 1 0 0 0; }
    ConfigOverlay Input {
        width: 1fr; height: 3; margin: 0;
        background: $boost; border: round $panel-lighten-2;
    }
    ConfigOverlay Input:focus { border: round $accent; }
    ConfigOverlay #cfg-save { width: auto; margin: 1 0 0 0; }
    PromptOptimizationOverlay { align: center middle; }
    PromptOptimizationOverlay #opt-card {
        width: 92; height: auto; max-height: 85%;
        background: $panel; border: round $accent; padding: 0 1;
    }
    PromptOptimizationOverlay #opt-reason { color: $text-muted; padding: 0 1 1 1; }
    PromptOptimizationOverlay TextArea {
        height: auto; max-height: 18; background: $boost; border: round $panel-lighten-2;
    }
    """

    def __init__(
        self,
        config: HarnessConfig,
        *,
        session: SessionStore,
        agent: MinimaAgent | None = None,
        tools: list[Any] | None = None,
        judge_every: int = 0,
        cwd: Path | None = None,
        system_prompt: str | None = None,
        load_session: bool = False,
        skip_permissions: bool = False,
        mouse: bool = True,
    ) -> None:
        super().__init__()
        self.config = config
        # Whether the app is capturing the mouse (scroll-wheel + in-app drag-select). Mirrors the
        # value passed to .run(mouse=...); /mouse flips it live. When on, the terminal's own
        # click-drag selection is suppressed (hold Option/Shift to bypass); when off, native
        # selection works but the wheel no longer scrolls the app (use PageUp/PageDown).
        self._mouse_enabled = mouse
        self.config.judge_every = judge_every  # default OFF in interactive mode
        self.session = session
        self.cwd = cwd or Path.cwd()
        self._tools = list(tools or default_toolset())
        # /goals: the agent's live task checklist + (Phase 2) cost-to-goal. The `tasks` tool is
        # appended here so it reaches the agent via _apply_extensions; the goal is loaded from
        # the session so it survives resume.
        from minima_harness.minima.goals import GoalStore
        from minima_harness.tools.tasks import tasks_tool

        self._goals = GoalStore()
        self._goals.load(self.session)
        self._tools.append(tasks_tool(self._goals))
        self._route_mode = "auto"  # auto | confirm (Ctrl+R cycles; /confirm sets it too)
        self._confirm_edits = False  # /edits: force a diff review for every edit/write
        # Ask before sensitive ops (write/edit/bash) by default; /yolo or
        # --dangerously-skip-permissions turns it off. _allow_always holds tools the user chose
        # to always-allow this session.
        self._ask_permission = not skip_permissions
        self._allow_always: set[str] = set()
        self._cache_enabled = config.cache_enabled  # /cache: serve near-duplicate prompts free
        self._cache = SemanticCache(threshold=config.cache_threshold)
        self._escalate = False
        self._escalate_threshold = 0.7
        # /thoughts: stream the model's reasoning into the log (off by default). The live
        # thinking bubble is (re)created per turn; empty ones are dropped after the turn.
        self._show_thinking = False
        self._thinking_bubble: Any = None
        # Spinner tips: passively surface a distinctive command per turn (Claude Code style).
        # The launch index drives the welcome splash; each turn advances to the next tip.
        from minima_harness.tui import tips as _tips

        self._tips_enabled = True
        self._tip_index = _tips.advance()
        self.agent = agent or MinimaAgent(
            self.config, tools=self._tools, meter=CostMeter(), system_prompt=system_prompt
        )
        self.agent.before_route = self._route_hook
        self.agent.before_tool_call = self._tool_hook
        self.bridge = EventBridge()
        self.commands = self._build_commands()
        self._extensions = load_extensions(self.cwd)
        self._ext_cmd_names: list[str] = []
        self._routing_offline = False
        self._rendered_msgs = 0
        self._stream_bubble: MessageBubble | None = None
        self._working = False
        self._footer_state: dict[str, Any] = self._default_footer_state()
        self._templates: dict[str, str] = {}
        self._skills: dict[str, str] = {}
        self._history: History = History(load_history(self.cwd))
        self._load_session_on_mount = load_session
        init_mubit(self.cwd)
        self._load_customization()
        self._apply_extensions()

    def _load_customization(self) -> None:
        from minima_harness.tui.customize import load_skills, load_templates
        from minima_harness.tui.mubit import available, get_skills
        from minima_harness.tui.theme import reload_file_themes

        reload_file_themes(self.cwd)
        self._templates = load_templates(self.cwd)
        self._skills = load_skills(self.cwd)
        # Merge Mubit-stored skills (project-scoped) alongside local SKILL.md files.
        if available():
            for skill in get_skills(self.cwd):
                name = skill.get("name") or skill.get("function", {}).get("name", "")
                inst = (
                    skill.get("instructions")
                    or skill.get("description")
                    or skill.get("function", {}).get("description", "")
                )
                if name and inst and name not in self._skills:
                    self._skills[name] = f"# Mubit skill: {name}\n{inst}"

    def _apply_theme(self) -> None:
        for bubble in self.query_one(ChatLog).query(MessageBubble):
            bubble.refresh_theme()
        self._refresh_footer()

    # ------------------------------------------------------------- extensions
    def _apply_extensions(self) -> None:
        """Merge extension tools/commands into the agent + registry (init + /reload)."""
        ext_tools = [t for ext in self._extensions for t in ext.tools]
        self.agent.state.tools = list(self._tools) + ext_tools
        for name in self._ext_cmd_names:
            self.commands.remove_command(name)
        self._ext_cmd_names = []
        for ext in self._extensions:
            for cname, cmd in ext.commands.items():
                self.commands.add_command(cmd)
                self._ext_cmd_names.append(cname)

    async def _extension_fanout(self, event: Any) -> None:
        if isinstance(event, ToolExecutionStartEvent):
            key = "tool_start"
        elif isinstance(event, ToolExecutionEndEvent):
            key = "tool_end"
        elif isinstance(event, AgentEndEvent):
            key = "finish"
        elif isinstance(event, MessageUpdateEvent):
            key = "text"
        elif isinstance(event, TurnEndEvent):
            key = "turn"
        else:
            return
        for ext in self._extensions:
            for handler in ext.hooks.get(key, []):
                try:
                    result = handler(event)
                    if inspect.isawaitable(result):
                        await result
                except Exception:  # noqa: BLE001 - an extension hook must not break the run
                    _log.warning("extension_hook_failed", exc_info=True)

    def _default_footer_state(self) -> dict[str, Any]:
        # Pre-turn placeholder: Minima picks the model per turn, so show "auto" rather
        # than the offline default (gpt-4o-mini), which would be misleading.
        return {
            "model": "auto",
            "basis": "minima",
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read": 0,
            "cache_write": 0,
            "ctx_pct": 0.0,
        }

    # ------------------------------------------------------------- layout
    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="banner")
        yield ChatLog(id="chatlog")
        yield OptionList(id="cmd-popup")
        yield Editor()
        yield StatusBar(id="status")
        yield TextualFooter()

    def get_key_display(self, binding: Binding) -> str:
        """Spell out ``ctrl+x`` in the footer instead of Textual's default ``^x`` caret.

        Mirrors the stock implementation byte-for-byte except the ctrl modifier renders as a
        literal ``ctrl+`` prefix — other modifiers (shift/alt) and bare keys (esc, pgup) keep
        their normal display.
        """
        if binding.key_display:
            return binding.key_display
        modifiers, key = binding.parse_key()
        key = format_key(key)
        if "ctrl" in modifiers:
            modifiers.pop(modifiers.index("ctrl"))
            key = f"ctrl+{key}"
        return "+".join([*modifiers, key])

    def on_mount(self) -> None:
        self.title = "Minima CLI"
        self.agent.subscribe(self.bridge)
        self.agent.subscribe(self._extension_fanout)
        self.bridge.bind(on_text=self._append_stream, on_thinking=self._on_thinking)
        self.query_one(Editor).prompt_history = self._history
        self.query_one(Editor).focus()
        self._refresh_footer()
        self._apply_effective_prompt()
        self.run_worker(self._show_welcome(), exclusive=True)

    def _apply_effective_prompt(self) -> None:
        """Recompute and apply the Mubit+local+session system prompt to the agent, with the
        active goal + open tasks appended so the model is re-anchored to the goal each turn."""
        base = effective_prompt(self.cwd, get_session_override(self.session))
        goal_block = self._goals.prompt_block()
        self.agent.state.system_prompt = f"{base}\n\n{goal_block}" if goal_block else base

    async def _apply_prompt_edit(self, result: dict) -> None:
        action, content = result["action"], result["content"]
        if action == "project":
            ok = mubit_set_prompt(content)
            msg = (
                "system prompt saved to Mubit (project, versioned)"
                if ok
                else "Mubit save failed — prompt unchanged"
            )
        else:
            set_session_override(self.session, content)
            msg = "session prompt override saved"
        self._apply_effective_prompt()
        await self.query_one(ChatLog).add_system(msg)

    async def _show_welcome(self) -> None:
        """Mount the ASCII welcome + status bubble at the top of the transcript."""
        from minima_harness.tui.welcome import render_welcome

        chatlog = self.query_one(ChatLog)
        welcome = Static(render_welcome(self), id="welcome")
        await chatlog.mount(welcome)
        chatlog.add_class("empty")  # center the splash until the first message lands
        chatlog.scroll_end(animate=False)
        if self._load_session_on_mount and self.session.entries:
            self.run_worker(self._load_session(self.session), exclusive=True)

    def _dismiss_welcome(self) -> None:
        """Remove the launch splash + un-center the transcript (called on the first turn)."""
        chatlog = self.query_one(ChatLog)
        for w in chatlog.query("#welcome"):
            w.remove()
        chatlog.remove_class("empty")

    def copy_to_clipboard(self, text: str) -> None:
        """Copy ``text`` to the clipboard. Textual's built-in copy (triggered by the in-app
        text selection + ⌘/Ctrl+C) emits *only* OSC 52, which macOS Terminal.app silently
        ignores — so a selection looked copied but wasn't. Also push to the OS clipboard tool
        (pbcopy/xclip/wl-copy) so selection-copy lands on the real clipboard everywhere, and
        through tmux/SSH. Run off the UI thread so a slow subprocess never stalls the app."""
        super().copy_to_clipboard(text)  # Textual: track _clipboard + emit OSC 52
        if not text:
            return
        try:
            self.run_worker(
                partial(_os_clipboard_copy, text),
                thread=True,
                group="clipboard",
                exclusive=True,
            )
        except Exception:  # noqa: BLE001 - copy must never crash the app
            _log.debug("clipboard_worker_failed", exc_info=True)

    def _set_mouse_capture(self, enabled: bool) -> bool:
        """Turn mouse capture on/off live via the driver. Returns True on success. Mouse capture
        is what trades terminal-native selection for scroll-wheel + in-app selection, so this lets
        a user flip between the two without restarting."""
        driver = getattr(self, "_driver", None)
        if driver is None:
            return False
        try:
            if enabled:
                driver._enable_mouse_support()
            else:
                driver._disable_mouse_support()
        except Exception:  # noqa: BLE001 - never crash on a terminal that can't toggle
            _log.debug("mouse_toggle_failed", exc_info=True)
            return False
        self._mouse_enabled = enabled
        return True

    # ------------------------------------------------------------- streaming
    def _set_state(self, state: str) -> None:
        try:
            self.query_one(StatusBar).set_state(state)
        except Exception:  # noqa: BLE001 - during teardown the widget may be gone
            pass

    def _set_spinner_tip(self) -> None:
        """Advance to the next tip and hand it to the loader (cleared when /tip off)."""
        from minima_harness.tui import tips

        try:
            tip = tips.format_tip(tips.pick(tips.advance())) if self._tips_enabled else ""
            self.query_one(StatusBar).set_tip(tip)
        except Exception:  # noqa: BLE001 - a tip must never break a turn
            pass

    def _append_stream(self, delta: str) -> None:
        self._set_state("working")
        if self._stream_bubble is not None:
            self._stream_bubble.append(delta)

    def _on_thinking(self, delta: str) -> None:
        self._set_state("thinking")
        if self._thinking_bubble is not None:
            self._thinking_bubble.append(delta)

    async def _finalize_thinking(self) -> None:
        """Drop the per-turn thinking bubble if the model produced no thoughts; else keep it."""
        if self._thinking_bubble is None:
            return
        if not self._thinking_bubble.buffer.strip():
            await self._thinking_bubble.remove()
        else:
            self._thinking_bubble.flush()
        self._thinking_bubble = None

    async def _emit_goal_cost_line(self, routing: Any) -> None:
        """Attribute this turn's realized cost to the active goal and show spent/projected/budget.

        The one thing no other agent does: frame the goal as a budget. spent = realized cost since
        the goal started; projected = linear extrapolation from task progress; budget warns (never
        blocks) when exceeded."""
        if routing is None or not self._goals.active or self._goals.goal is None:
            return
        meter = self.agent.meter
        if meter is None or not meter.rows:
            return
        row = meter.rows[-1]
        # Tasks the model flipped to completed THIS turn get the cost split across them (covers
        # the common case: model plans, works, then marks several done with no in_progress step).
        before: set[str] = getattr(self, "_goal_completed_before", set())
        newly_completed = [tid for tid in self._goals.completed_ids() if tid not in before]
        self._goals.record_turn_cost(row.actual_cost_usd, row.est_cost_usd, newly_completed)
        g = self._goals.goal
        spent = g.spent_usd()
        parts = [f"spent ${spent:.4f}"]
        proj = g.projected_total_usd()
        if proj is not None:
            parts.append(f"~${proj:.4f} projected")
        over = False
        if g.budget_usd:
            pct = (100.0 * spent / g.budget_usd) if g.budget_usd > 0 else 0.0
            over = spent > g.budget_usd
            parts.append(f"budget ${g.budget_usd:.4f} ({pct:.0f}%)")
        await self.query_one(ChatLog).add_system(
            "   └ ledger · " + " · ".join(parts), color="red" if over else None
        )

    async def _check_escalate(self, routing: Any, task_text: str) -> None:
        """Judge the output and suggest escalating if quality < threshold."""
        chatlog = self.query_one(ChatLog)
        last = self.agent._last_assistant()
        if last is None or not last.text.strip():
            return
        try:
            quality = await self.agent.judge.grade(task_text, last.text)
        except Exception:  # noqa: BLE001
            return
        if quality is not None and quality < self._escalate_threshold:
            stronger = max(
                routing.ranked,
                key=lambda r: r.predicted_success,
                default=None,
            )
            if stronger and stronger.model_id != routing.chosen_model_id:
                await chatlog.add_system(
                    f"↗ quality {quality:.2f} < {self._escalate_threshold} — "
                    f"consider {stronger.model_id} ({stronger.predicted_success:.0%} success). "
                    f"/model {stronger.model_id} to pin it."
                )
            elif quality is not None:
                await chatlog.add_system(
                    f"quality {quality:.2f} < {self._escalate_threshold} "
                    f"(already on the strongest candidate)"
                )

    async def _emit_cost_line(self) -> None:
        """Close the loop visibly: est (from recommend) -> actual (from feedback) per turn."""
        meter = self.agent.meter
        if meter is None or not meter.rows:
            return
        r = meter.rows[-1]
        parts = [f"est ${r.est_cost_usd:.4f} → actual ${r.actual_cost_usd:.4f}"]
        if r.baseline_cost_usd is not None:
            save = r.baseline_cost_usd - r.actual_cost_usd
            pct = (100.0 * save / r.baseline_cost_usd) if r.baseline_cost_usd > 0 else 0.0
            verb = "saved" if save >= 0 else "over"
            parts.append(f"{verb} ${abs(save):.4f} ({abs(pct):.0f}%) vs baseline")
        await self.query_one(ChatLog).add_system("   └ " + " · ".join(parts))

    async def _route_hook(self, routing: Any, task_text: str) -> Any:
        """before_route hook: always emits a rationale line; shows confirm panel when on."""
        chatlog = self.query_one(ChatLog)
        reason = ""
        if routing is not None:
            chosen = routing.chosen_model_id or routing.model.id
            chosen_r = _chosen_ranking(routing)
            level, color = _confidence_band(routing)
            extra = _reasoner_note(routing)
            cost = _fmt_cost_range(
                routing.est_cost_usd, routing.est_cost_low, routing.est_cost_high
            )
            lat = _fmt_latency(chosen_r.est_latency_ms if chosen_r else None)
            line = (
                f"● routed to {chosen} · {routing.decision_basis} · {cost} · {lat} "
                f"· conf {routing.confidence:.0%} ({level}){extra}"
            )
            await chatlog.add_system(line, color=color)
            reason = _routing_reason(routing)
            if reason:
                await chatlog.add_system(f"   └ {reason}")  # cost/speed/predictability story
        if self._route_mode != "confirm" or routing is None:
            return None  # accept as-is
        result = await self.push_screen(RoutingConfirm(routing, reason), wait_for_dismiss=True)
        if result is None or result.get("action") == "cancel":
            routing.recommendation_id = None  # veto feedback
            return routing
        chosen_id = result.get("model_id")
        action = result.get("action")
        if chosen_id:
            provider = next((r.provider for r in routing.ranked if r.model_id == chosen_id), "")
            model = self.agent.router.mapping._resolve(provider, chosen_id)  # noqa: SLF001
            if model is not None:
                routing.model = model
                routing.chosen_model_id = chosen_id
            else:
                # The pick isn't a model the harness can actually call (id unknown to the
                # registry) — say so instead of silently running the originally-routed model.
                await chatlog.add_error(
                    f"can't switch to {chosen_id} — not a registered model; "
                    f"running {routing.chosen_model_id or routing.model.id}"
                )
        if action == "pin" and chosen_id:
            self.config.candidates = [chosen_id]
        return routing

    def _tool_preview(self, name: str, args: Any) -> str:
        """What a sensitive tool call will do, for the permission modal: a diff for write/edit,
        the command for bash, else a compact summary."""
        if name in _MUTATING_TOOLS:
            from minima_harness.tui.diff import render_tool_diff

            return render_tool_diff(name, args)
        if name == "bash":
            return f"$ {getattr(args, 'command', '') or ''}"
        return _format_tool_call(name, args)

    async def _tool_hook(self, ctx: Any) -> Any:
        """before_tool_call hook: ask the user to approve sensitive ops (write/edit/bash) before
        they run — Claude-Code-style. Approval is needed when permission-asking is on and the
        tool isn't already always-allowed, OR when /edits forces a diff review for edits.

        A rejected call is blocked (the model sees the rejection) AND recorded as a ground-truth
        negative outcome fed back to Minima.
        """
        from minima_harness.agent.tools import BeforeToolCallResult

        name = ctx.tool_call.name
        forced = self._confirm_edits and name in _MUTATING_TOOLS
        gated = self._ask_permission and name in _SENSITIVE_TOOLS and name not in self._allow_always
        if not (forced or gated):
            return None
        target = getattr(ctx.args, "path", "") or ""
        preview = self._tool_preview(name, ctx.args)
        result = await self.push_screen(
            PermissionRequest(name, preview, target), wait_for_dismiss=True
        )
        action = (result or {}).get("action", "reject")
        if action == "always":
            self._allow_always.add(name)  # don't ask again for this tool this session
            return None
        if action == "approve":
            return None
        self.agent.record_tool_rejection()
        await self.query_one(ChatLog).add_error(f"rejected {name} {target}".rstrip())
        return BeforeToolCallResult(
            block=True,
            reason="The user rejected this tool call. Do not retry it verbatim — propose a "
            "different approach or ask what they want.",
        )

    # ------------------------------------------------------------- input
    async def on_editor_submitted(self, event: Editor.Submitted) -> None:
        text = event.text
        self.query_one("#cmd-popup", OptionList).set_class(False, "visible")
        if text.strip():
            self._history.add(text)
            append_history(self.cwd, text)
        if self.agent.state.is_streaming:
            # Enter while running = steering (delivered after the current tool batch).
            self.agent.steer(text)
            self.query_one(Editor).text = ""
            await self.query_one(ChatLog).add_system(f"↳ (steering) {text}")
            return
        self.query_one(Editor).text = ""
        parsed = parse_submission(text)
        kind = parsed["kind"]
        if kind == "command":
            await self._dispatch_command(parsed["name"], parsed["args"])
            self._refresh_footer()
            return
        self.run_worker(self._run_submission(parsed), exclusive=True, name="turn")

    async def on_editor_follow_up(self, event: Editor.FollowUp) -> None:
        text = event.text
        if not text.strip():
            return
        self.agent.follow_up(text)
        self.query_one(Editor).text = ""
        await self.query_one(ChatLog).add_system(f"↳ (follow-up) {text}")

    # ------------------------------------------------------------- command popup
    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        text = event.text_area.text
        popup = self.query_one("#cmd-popup", OptionList)
        frag = text[1:] if text.startswith("/") else ""
        if text.startswith("/") and " " not in frag:
            matches = [c for c in self.commands.all() if not frag or c.name.startswith(frag)]
            if matches:
                popup.clear_options()
                for c in matches:
                    label = f"/{c.name}  {c.description}".rstrip()
                    popup.add_option(Option(label, id=c.name))
                popup.set_class(True, "visible")
            else:
                popup.set_class(False, "visible")
        else:
            popup.set_class(False, "visible")

    def on_editor_complete_requested(self, event: Editor.CompleteRequested) -> None:
        text = event.text
        if not text.startswith("/") or " " in text[1:]:
            return
        frag = text[1:]
        matches = [c for c in self.commands.all() if not frag or c.name.startswith(frag)]
        if not matches:
            return
        ed = self.query_one(Editor)
        ed.text = f"/{matches[0].name} "
        ed.move_cursor((0, len(ed.text)))
        self.query_one("#cmd-popup", OptionList).set_class(False, "visible")

    def on_editor_cycle_thinking(self, event: Editor.CycleThinking) -> None:
        levels = ("off", "low", "medium", "high")
        cur = self.agent.state.thinking_level
        nxt = levels[(levels.index(cur) + 1) % len(levels)] if cur in levels else "low"
        self.agent.state.thinking_level = nxt  # type: ignore[assignment]
        self._refresh_footer()  # thinking level lives in the footer now, not the warning banner

    async def _run_submission(self, parsed: dict) -> None:
        try:
            if parsed["kind"] == "bash":
                output = await run_bash(parsed["command"])
                if parsed["feed"]:
                    await self.run_turn(output)
                else:
                    await self.query_one(ChatLog).add_system(f"$ {parsed['command']}\n{output}")
            elif parsed["kind"] == "message":
                await self.run_turn(parsed["text"])
        except Exception:  # noqa: BLE001 - a bad turn must not kill the app
            _log.warning("turn_failed", exc_info=True)
            await self.query_one(ChatLog).add_error("turn failed (see logs)")

    # ------------------------------------------------------------- a turn
    async def run_turn(self, text: str) -> None:
        chatlog = self.query_one(ChatLog)
        self._dismiss_welcome()  # first prompt: drop the splash, let the conversation flow top-down
        self._apply_effective_prompt()  # re-anchor the goal/tasks into the system prompt
        await chatlog.add_user(text)
        self.session.append(EntryType.USER, {"text": text})
        if self._cache_enabled:
            hit = self._cache.get(text)
            if hit is not None:
                await self._serve_cache_hit(text, hit)
                return
        # A live "thinking" bubble (above the answer) when /thoughts is on; dropped if empty.
        self._thinking_bubble = await chatlog.add_thinking_stream() if self._show_thinking else None
        self._stream_bubble = await chatlog.add_assistant_stream()
        self._set_spinner_tip()
        self._set_state("routing")
        routing = None
        resp_text = ""
        # Goal-conditioned routing: an active goal supplies task_type + a goal tag so the whole
        # goal routes coherently and clusters in Minima's memory.
        g_type, g_tags = (None, None)
        self._goal_completed_before = self._goals.completed_ids()  # for per-task cost attribution
        if self._goals.active and self._goals.goal is not None:
            g_type, g_tags = self._goals.goal.routing_signals()
        try:
            routing = await self.agent.prompt(text, task_type=g_type, tags=g_tags)
        except Exception as exc:  # noqa: BLE001
            self._set_state("idle")
            await self._finalize_thinking()
            if self._stream_bubble is not None:
                await self._stream_bubble.remove()  # never leave an empty bubble behind
                self._stream_bubble = None
            await chatlog.add_error(str(exc))
            self._set_banner(str(exc))
            return
        await self._finalize_thinking()
        await self._render_tools_post_turn()
        # A provider call that failed (bad/missing key, 404, rate limit, network) is swallowed
        # into an empty assistant (stop_reason="error"); the agent classifies it as _last_error.
        # Surface that reason instead of leaving a silent blank bubble.
        turn_error = getattr(self.agent, "_last_error", None)
        if self._stream_bubble is not None:
            if turn_error and not self._stream_bubble.buffer.strip():
                await self._stream_bubble.remove()  # no output at all → drop the blank bubble
            else:
                self._stream_bubble.render_markdown()
                resp_text = self._stream_bubble.buffer
                _last = self.agent._last_assistant()
                _usage = _last.usage if _last is not None else None
                self.session.append(
                    EntryType.ASSISTANT,
                    {
                        "text": self._stream_bubble.buffer,
                        "model": routing.chosen_model_id if routing else None,
                        "in_tokens": _usage.input if _usage else 0,
                        "out_tokens": _usage.output if _usage else 0,
                        "cost": _usage.cost.total if _usage else 0.0,
                        # est cost (+ band) so predictability (est-vs-actual) is computable later.
                        "est_cost": routing.est_cost_usd if routing else 0.0,
                        "est_cost_low": routing.est_cost_low if routing else None,
                        "est_cost_high": routing.est_cost_high if routing else None,
                    },
                )
            self._stream_bubble = None
        if turn_error:
            # The *model call* failed (routing succeeded) — surface it as a model error, NOT
            # the "routing offline … /reconnect to retry Minima" banner (reconnecting won't fix
            # a bad provider key / quota / 404). The message already names the next step.
            await chatlog.add_error(turn_error)
            # Show the provider's RAW words too (muted) — an ambiguous 403/429 ("permission, or
            # no quota") is only diagnosable from the provider's exact reason.
            raw = getattr(self.agent, "_last_error_raw", None)
            if raw and raw.strip() and raw.strip() not in turn_error:
                await chatlog.add_system(f"   └ provider said: {_snippet(raw, 300)}")
            self._set_model_error_banner(turn_error)
            self._scroll_bottom()
            self._refresh_footer()
            self._set_state("idle")
            return
        # If a dead-key provider was auto-rerouted around, say so (the turn otherwise looks like a
        # normal success on the fallback model — the user should know their key was rejected).
        reroute = getattr(self.agent, "_reroute_note", None)
        if reroute and resp_text.strip():
            model = routing.chosen_model_id if routing else "an available model"
            await chatlog.add_system(f"⚠ {reroute} · re-routed to {model}", color="yellow")
        self._scroll_bottom()
        await self._emit_cost_line()
        await self._emit_goal_cost_line(routing)
        if self._escalate and routing is not None:
            await self._check_escalate(routing, text)
        # Cache a clean, successful answer so a near-duplicate prompt is free next time.
        if self._cache_enabled and routing is not None and resp_text:
            self._cache.put(text, resp_text)
        self._after_turn(routing)

    async def _serve_cache_hit(self, text: str, hit: Any) -> None:
        """Return a cached response: render it, log a $0 CostMeter row, skip Minima entirely."""
        chatlog = self.query_one(ChatLog)
        bubble = await chatlog.add_assistant_stream()
        bubble.set_text(hit.response)
        bubble.render_markdown()
        self.session.append(
            EntryType.ASSISTANT,
            {
                "text": hit.response,
                "model": "(cache)",
                "in_tokens": 0,
                "out_tokens": 0,
                "cost": 0.0,
            },
        )
        await chatlog.add_system(
            f"⚡ cache hit (similarity {hit.similarity:.2f}) · $0.0000", color="green"
        )
        meter = self.agent.meter
        if meter is not None:
            meter.rows.append(
                CostRow(
                    label=text.splitlines()[0][:48] if text.strip() else "(empty)",
                    model="(cache)",
                    decision_basis="cache",
                    est_cost_usd=0.0,
                    actual_cost_usd=0.0,
                    baseline_cost_usd=None,
                    quality=None,
                    outcome="success",
                )
            )
        self._scroll_bottom()
        self._refresh_footer()
        self._set_state("idle")

    async def _render_tools_post_turn(self) -> None:
        chatlog = self.query_one(ChatLog)
        for msg in self.agent.state.messages[self._rendered_msgs :]:
            if isinstance(msg, AssistantMessage):
                for call in msg.tool_calls:
                    await chatlog.add_tool(call.name, _format_tool_call(call.name, call.arguments))
            elif msg.role == "toolResult":
                # Errors (incl. permission/sandbox failures) get more room + a prominent ✗ so a
                # failed tool is never an easy-to-miss faint line.
                limit = 400 if msg.is_error else 120
                await chatlog.add_tool_result(_snippet(msg.text, limit), msg.is_error)
        self._rendered_msgs = len(self.agent.state.messages)

    async def _load_session(self, store: SessionStore) -> None:
        """Switch the active session and rebuild the agent context + transcript from it."""
        self.session = store
        self._goals.load(store)  # restore the session's goal/task list
        chatlog = self.query_one(ChatLog)
        await chatlog.remove_children()
        chatlog.remove_class("empty")
        self._rendered_msgs = 0
        msgs: list = []
        for entry in store.entries:
            txt = entry.payload.get("text", "")
            if entry.type == EntryType.USER:
                await chatlog.add_user(txt)
                msgs.append(Message(role="user", content=txt))
            elif entry.type == EntryType.ASSISTANT:
                bubble = await chatlog.add_assistant_stream()
                bubble.set_text(txt)
                bubble.render_markdown()
                msgs.append(AssistantMessage(role="assistant", content=[TextContent(text=txt)]))
        self.agent.state.messages = msgs
        self._rendered_msgs = len(msgs)
        label = store.display_name or (store.path.stem if store.path else "ephemeral")
        await chatlog.add_system(f"resumed {label} ({len(msgs)} msg(s) in context)")
        self._refresh_footer()

    def _after_turn(self, routing: Any) -> None:
        if routing is None:
            # Offline fallback. A retryable cause (unreachable/timeout) gets the
            # "routing offline … /reconnect" framing; a config/auth cause (no/invalid key)
            # gets the actionable banner instead — /reconnect alone wouldn't fix it.
            self._routing_offline = True
            reason = getattr(self.agent, "_offline_reason", None) or "Minima unreachable"
            retryable = getattr(self.agent, "_offline_retryable", True)
            model = self.agent.state.model.id if self.agent.state.model else "default model"
            self._footer_state["model"] = model
            self._footer_state["basis"] = "offline"
            if retryable:
                self._set_banner(f"{reason} — ran {model} unrouted")
            else:
                self._set_config_banner(f"{reason} (ran {model} unrouted)")
        else:
            # Routing SUCCEEDED. Surface only actionable, not-already-inline conditions —
            # never the "routing offline/reconnect" framing (that's a false alarm here).
            self._footer_state = self._routing_footer_state(routing)
            notices = _banner_warnings(routing.warnings)
            if notices:
                self._set_notice("; ".join(notices[:2]))
            elif self._footer_state["ctx_pct"] > 80:
                self._set_notice("context near limit — /compact to free space")
            else:
                self.query_one("#banner", Static).update(Text(""))
        # Persist any goal/task changes the model made via the `tasks` tool this turn.
        self._goals.save(self.session)
        self._refresh_footer()
        self._set_state("idle")

    def _routing_footer_state(self, routing: Any) -> dict[str, Any]:
        last = self.agent._last_assistant()
        usage = last.usage if last is not None else None
        ctx = 0.0
        if usage is not None and routing.model.context_window:
            ctx = 100.0 * usage.input / max(1, routing.model.context_window)
        return {
            "model": routing.chosen_model_id or routing.model.id,
            "basis": routing.decision_basis,
            "input_tokens": usage.input if usage else 0,
            "output_tokens": usage.output if usage else 0,
            "cache_read": usage.cache_read if usage else 0,
            "cache_write": usage.cache_write if usage else 0,
            "ctx_pct": ctx,
        }

    # ------------------------------------------------------------- overlay
    def _set_banner(self, reason: str) -> None:
        self.query_one("#banner", Static).update(render_banner(reason))

    def _set_config_banner(self, reason: str) -> None:
        """Offline due to a config/auth issue — actionable, without '/reconnect' framing."""
        self.query_one("#banner", Static).update(render_config_banner(reason))

    def _set_model_error_banner(self, reason: str) -> None:
        """The model call failed (routing was fine) — actionable, no '/reconnect' framing."""
        self.query_one("#banner", Static).update(render_model_error_banner(reason))

    def _clear_banner(self) -> None:
        """Drop any standing banner (e.g. after switching models — a prior model's error or
        offline state no longer applies)."""
        self._routing_offline = False
        self.query_one("#banner", Static).update(Text(""))

    def _set_notice(self, reason: str) -> None:
        """A non-offline heads-up (no '/reconnect' framing — routing succeeded)."""
        self.query_one("#banner", Static).update(render_notice(reason))

    def _goal_footer(self) -> str:
        """`N/M` progress for the active goal (empty when none) — shown in the footer."""
        if not self._goals.active or self._goals.goal is None:
            return ""
        done, total = self._goals.goal.progress()
        return f"{done}/{total}"

    def _refresh_footer(self) -> None:
        meter = self.agent.meter or CostMeter()
        session_label = self.session.display_name or (
            self.session.path.stem if self.session.path else "ephemeral"
        )
        self.title = "Minima CLI"
        self.sub_title = ""
        footer = render_footer(
            cwd=str(self.cwd),
            session_id=session_label,
            model=self._footer_state["model"],
            basis=self._footer_state["basis"],
            meter=meter,
            input_tokens=self._footer_state["input_tokens"],
            output_tokens=self._footer_state["output_tokens"],
            cache_read=self._footer_state["cache_read"],
            cache_write=self._footer_state["cache_write"],
            ctx_pct=self._footer_state["ctx_pct"],
            routing_offline=self._routing_offline,
            route_mode=self._route_mode,
            thinking_level=str(self.agent.state.thinking_level),
            goal=self._goal_footer(),
        )
        self.sub_title = ""
        try:
            self.query_one(StatusBar).set_idle_text(footer)  # rich Text: keep per-segment colour
        except Exception:  # noqa: BLE001 - not mounted yet during early init
            pass

    # ------------------------------------------------------------- commands
    def _build_commands(self) -> CommandRegistry:
        reg = CommandRegistry()

        async def _quit(app: HarnessApp, args: str) -> None:
            app.exit()

        async def _clear(app: HarnessApp, args: str) -> None:
            await app.query_one(ChatLog).remove_children()
            await app._show_welcome()

        async def _banner(app: HarnessApp, args: str) -> None:
            from minima_harness.tui.welcome import render_welcome

            chatlog = app.query_one(ChatLog)
            existing = list(chatlog.query("#welcome"))
            if existing:
                for w in existing:
                    w.remove()
                chatlog.remove_class("empty")
                await chatlog.add_system("welcome hidden · /banner to show")
            else:
                w = Static(render_welcome(app), id="welcome")
                kids = list(chatlog.children)
                if kids:
                    await chatlog.mount(w, before=kids[0])
                else:
                    await chatlog.mount(w)
                    chatlog.add_class("empty")

        async def _cost(app: HarnessApp, args: str) -> None:
            meter = app.agent.meter
            await app.query_one(ChatLog).add_system(meter.report() if meter else "(no meter)")

        async def _help(app: HarnessApp, args: str) -> None:
            await app.query_one(ChatLog).add_system(app.commands.help_text())

        async def _model(app: HarnessApp, args: str) -> None:
            from minima_harness.ai import all_models
            from minima_harness.ai.provider_catalog import runnable_candidates
            from minima_harness.minima.config import DEFAULT_CANDIDATES

            def _unpin() -> None:
                # Release any pin: restore the full runnable candidate pool so Minima routes.
                app.config.candidates = runnable_candidates(list(DEFAULT_CANDIDATES))
                app.config.pinned = False
                app._footer_state["model"] = "auto"
                app._footer_state["basis"] = "minima"
                app._clear_banner()  # a prior model's error/offline banner no longer applies
                app._refresh_footer()

            # `/model auto` (or unpin/clear) releases the pin without opening the picker.
            if args.strip().lower() in ("auto", "unpin", "clear"):
                _unpin()
                await app.query_one(ChatLog).add_system("model: auto — Minima routes each turn")
                return

            # Offer the union of routing candidates + every registered model (candidates first,
            # deduped) so a user can pin ANY provider's model — e.g. a Groq/DeepSeek model that
            # isn't in the default routing pool. Pinning sets candidates=[chosen].
            cands = list(app.config.candidates or [])
            cands = list(dict.fromkeys(cands + [m.id for m in all_models()]))
            providers = {m.id: m.provider for m in all_models()}
            active = app._footer_state.get("model")
            basis = app._footer_state.get("basis")
            # Pinned iff the config holds exactly one candidate (check the CONFIG, not the
            # union `cands` above which is always >1 — the old check could never detect a pin).
            pinned = app.config.candidates[0] if len(app.config.candidates or []) == 1 else None

            def _picked(chosen: str | None) -> None:
                if not chosen:
                    return
                if chosen == ModelPicker.AUTO:
                    _unpin()  # explicit "auto" entry: unpin back to Minima routing
                    return
                app.config.candidates = [chosen]  # pin → run this model directly (bypass Minima)
                app.config.pinned = True
                app._footer_state["model"] = chosen
                app._footer_state["basis"] = "pinned"
                # Clear any banner from the previous model — switching to `chosen` makes a
                # prior model's "access denied"/offline banner stale and misleading.
                app._clear_banner()
                app._refresh_footer()  # reflect the pin immediately

            app.push_screen(
                ModelPicker(
                    cands,
                    active=active,
                    basis=basis,
                    pinned=pinned,
                    providers=providers,
                ),
                callback=_picked,
            )

        async def _reconnect(app: HarnessApp, args: str) -> None:
            # Rebuild the Minima client from the current env so a key/URL set via /config (or
            # exported since launch) actually takes effect — the old client's auth header was
            # fixed at build time, which is why a plain banner-clear wasn't enough before.
            await app.agent.reconnect()
            app._routing_offline = False
            app.query_one("#banner", Static).update(Text(""))
            if (app.agent.config.minima_api_key or "").strip():
                msg = "reconnected (next turn routes via Minima)"
            else:
                msg = (
                    "reconnected — but no Mubit API key set, so routing stays offline; "
                    "add MUBIT_API_KEY via /config"
                )
            await app.query_one(ChatLog).add_system(msg)

        async def _new(app: HarnessApp, args: str) -> None:
            app.session = SessionManager().new(app.cwd, name=args or None)
            await app.query_one(ChatLog).remove_children()
            sid = app.session.path.stem if app.session.path else "ephemeral"
            await app.query_one(ChatLog).add_system(f"new session: {sid}")

        async def _name(app: HarnessApp, args: str) -> None:
            app.session.display_name = args or None

        async def _session(app: HarnessApp, args: str) -> None:
            p = app.session.path
            await app.query_one(ChatLog).add_system(
                f"session: {p.stem if p else 'ephemeral'} · entries={len(app.session.entries)} "
                f"· name={app.session.display_name or '-'}"
            )

        async def _tree(app: HarnessApp, args: str) -> None:
            app.push_screen(TreePicker(app.session))

        async def _fork(app: HarnessApp, args: str) -> None:
            entry_id = args.strip()
            if not entry_id or not app.session.persistent:
                await app.query_one(ChatLog).add_error(
                    "usage: /fork <entry-id> (requires a saved session)"
                )
                return
            dest = SessionManager().new(app.cwd).path
            assert dest is not None
            app.session.fork_to(dest, from_entry_id=entry_id)
            await app.query_one(ChatLog).add_system(f"forked to {dest.stem}")

        async def _clone(app: HarnessApp, args: str) -> None:
            if not app.session.persistent:
                await app.query_one(ChatLog).add_error("clone requires a saved session")
                return
            dest = SessionManager().new(app.cwd).path
            assert dest is not None
            app.session.clone_to(dest)
            await app.query_one(ChatLog).add_system(f"cloned to {dest.stem}")

        async def _resume(app: HarnessApp, args: str) -> None:
            if args.strip():
                try:
                    store = SessionManager().open(app.cwd, session_id=args.strip())
                except FileNotFoundError as exc:
                    await app.query_one(ChatLog).add_error(str(exc))
                    return
                await app._load_session(store)
                return
            summaries = SessionManager().list_sessions(app.cwd)

            def _picked(chosen: str | None) -> None:
                if chosen:
                    store = SessionStore.file_backed(Path(chosen))
                    app.run_worker(app._load_session(store), exclusive=True)

            app.push_screen(SessionPicker(summaries), callback=_picked)

        async def _judge(app: HarnessApp, args: str) -> None:
            on = args.strip().lower() in {"on", "1", "true", "yes"}
            if not args.strip():
                on = app.config.judge_every == 0
            app.config.judge_every = 1 if on else 0
            await app.query_one(ChatLog).add_system(
                f"judging {'on' if on else 'off'} (judge_every={app.config.judge_every})"
            )

        async def _theme(app: HarnessApp, args: str) -> None:
            from minima_harness.tui.theme import available_themes, current_theme, set_theme

            avail = available_themes()
            name = args.strip().lower()
            if name and name in avail:
                set_theme(name)
                app._apply_theme()
                await app.query_one(ChatLog).add_system(f"theme: {name}")
                return
            cur = current_theme()

            def _picked(chosen: str | None) -> None:
                if chosen and chosen in avail:
                    set_theme(chosen)
                    app._apply_theme()

            app.push_screen(ModelPicker(sorted(avail), active=cur), callback=_picked)

        async def _compact(app: HarnessApp, args: str) -> None:
            agent = app.agent
            msgs = agent.state.messages
            if len(msgs) < 6:
                await app.query_one(ChatLog).add_system("not enough conversation to compact")
                return
            keep = max(2, len(msgs) // 4)
            old, recent = msgs[:-keep], msgs[-keep:]
            model = getattr(getattr(agent, "judge", None), "_model", None) or agent.state.model
            assert model is not None
            try:
                summary = await summarize(old, model, instructions=args)
            except Exception as exc:  # noqa: BLE001
                await app.query_one(ChatLog).add_error(f"compact failed: {exc}")
                return
            note = Message(
                role="user", content=f"<compacted_context>\n{summary}\n</compacted_context>"
            )
            agent.state.messages = [note] + list(recent)
            app._rendered_msgs = len(agent.state.messages)
            await app.query_one(ChatLog).add_system(
                f"compacted {len(old)} msg(s) → summary (kept {keep})"
            )

        async def _ext_list(app: HarnessApp, args: str) -> None:
            if not app._extensions:
                await app.query_one(ChatLog).add_system("no extensions loaded")
                return
            lines = []
            for ext in app._extensions:
                nhooks = sum(len(v) for v in ext.hooks.values())
                lines.append(
                    f"{ext.name}: {len(ext.tools)} tool(s), {len(ext.commands)} cmd(s), "
                    f"{nhooks} hook(s)"
                )
            await app.query_one(ChatLog).add_system("\n".join(lines))

        async def _reload(app: HarnessApp, args: str) -> None:
            app._extensions = load_extensions(app.cwd)
            app._apply_extensions()
            app._load_customization()
            await app.query_one(ChatLog).add_system(
                f"reloaded: {len(app._extensions)} extension(s)"
            )

        async def _copy(app: HarnessApp, args: str) -> None:
            import os
            import tempfile

            text = args.strip()
            if not text:
                last = app.agent._last_assistant()
                text = last.text if last is not None else ""
            if not text:
                # fall back to the last assistant bubble shown in the transcript
                for bubble in reversed(app.query_one(ChatLog).query(MessageBubble)):
                    if getattr(bubble, "_role", "") == "assistant" and bubble.buffer:
                        text = bubble.buffer
                        break
            if not text:
                await app.query_one(ChatLog).add_system("nothing to copy yet (run a prompt first)")
                return
            # run the clipboard call off the event loop for a clean subprocess context
            ok = await anyio.to_thread.run_sync(_os_clipboard_copy, text)
            if ok:
                await app.query_one(ChatLog).add_system(f"copied {len(text)} char(s) to clipboard")
            else:
                fd, path = tempfile.mkstemp(suffix=".txt", prefix="minima-harness-")
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(text)
                await app.query_one(ChatLog).add_error(
                    f"clipboard unavailable — wrote {len(text)} char(s) to {path}"
                )

        async def _mouse(app: HarnessApp, args: str) -> None:
            from minima_harness.tui.welcome import selection_hint

            arg = args.strip().lower()
            if arg in ("on", "1", "true", "yes"):
                want = True
            elif arg in ("off", "0", "false", "no"):
                want = False
            else:
                want = not app._mouse_enabled  # bare /mouse toggles
            if not app._set_mouse_capture(want):
                await app.query_one(ChatLog).add_error(
                    "couldn't change mouse capture on this terminal"
                )
                return
            await app.query_one(ChatLog).add_system(
                f"mouse {'ON' if want else 'OFF'} · {selection_hint(want)}"
            )

        async def _export(app: HarnessApp, args: str) -> None:
            target = (
                Path(args.strip())
                if args.strip()
                else (
                    Path.cwd() / f"{(app.session.path.stem if app.session.path else 'session')}.md"
                )
            )
            md = _conversation_to_markdown(app.agent.state.messages)
            try:
                target.write_text(md, encoding="utf-8")
            except OSError as exc:  # noqa: BLE001
                await app.query_one(ChatLog).add_error(f"export failed: {exc}")
                return
            await app.query_one(ChatLog).add_system(
                f"exported {len(md)} char(s) → {target} (open as Markdown for the formatted view)"
            )

        async def _commands(app: HarnessApp, args: str) -> None:
            def _picked(chosen: str | None) -> None:
                if chosen:
                    app.run_worker(app._dispatch_command(chosen, ""), exclusive=True)

            app.push_screen(CommandPicker(app.commands.all()), callback=_picked)

        async def _prompt(app: HarnessApp, args: str) -> None:
            so = get_session_override(app.session)
            layers = prompt_layers(app.cwd, so)
            breakdown = layer_token_breakdown(app.cwd, app.agent.state.messages, so)
            project_text = get_prompt()  # current Mubit system prompt (may be empty)

            def _saved(result: dict | None) -> None:
                if result:
                    app.run_worker(app._apply_prompt_edit(result), exclusive=True)

            app.push_screen(
                LayeredPromptInspector(layers, project_text, so, breakdown), callback=_saved
            )

        async def _config(app: HarnessApp, args: str) -> None:
            # Changing any of these requires rebuilding the Minima client (its auth header +
            # base URL are fixed at build time); provider keys, by contrast, resolve from
            # os.environ on each call, so they apply immediately.
            routing_keys = {"MUBIT_API_KEY", "MINIMA_API_KEY", "MINIMA_URL", "MUBIT_ENDPOINT"}

            def _saved(changes: dict | None) -> None:
                if not changes:
                    return
                # Live-apply to the running session so provider calls pick keys up at once.
                for key, val in changes.items():
                    os.environ[key] = val
                    f = config_store.field_for(key)
                    for alias in f.aliases if f else ():
                        os.environ[alias] = val

                async def _apply() -> None:
                    note = "provider keys apply now"
                    if routing_keys & set(changes):
                        # Rebuild the routing client so a just-entered Mubit key / URL works
                        # this session — no restart, no separate /reconnect needed.
                        await app.agent.reconnect()
                        app._routing_offline = False
                        app.query_one("#banner", Static).update(Text(""))
                        note = (
                            "routing reconnected"
                            if (app.agent.config.minima_api_key or "").strip()
                            else "still no Mubit API key — routing stays offline"
                        )
                    await app.query_one(ChatLog).add_system(
                        f"config: updated {', '.join(sorted(changes))} — {note}"
                    )

                app.run_worker(_apply(), exclusive=False)

            app.push_screen(ConfigOverlay(), callback=_saved)

        async def _optimize(app: HarnessApp, args: str) -> None:
            opt = propose_prompt_optimization(app.cwd)
            if opt is None:
                await app.query_one(ChatLog).add_system(
                    "no prompt optimization available "
                    "(Mubit returned nothing and no local savings found)"
                )
                return

            def _applied(result: dict | None) -> None:
                if result and result.get("action") == "apply":
                    app.run_worker(
                        app._apply_prompt_edit({"action": "project", "content": result["content"]}),
                        exclusive=True,
                    )

            app.push_screen(PromptOptimizationOverlay(opt), callback=_applied)

        async def _skills(app: HarnessApp, args: str) -> None:
            if not app._skills:
                await app.query_one(ChatLog).add_system("no skills loaded (local or Mubit)")
                return
            lines = []
            for sname in sorted(app._skills):
                src = "Mubit" if app._skills[sname].startswith("# Mubit skill:") else "local"
                lines.append(f"  {sname}  ({src})")
            await app.query_one(ChatLog).add_system("Skills:\n" + "\n".join(lines))

        async def _confirm(app: HarnessApp, args: str) -> None:
            on = args.strip().lower() in {"on", "1", "true", "yes"}
            if not args.strip():
                on = app._route_mode != "confirm"
            app._route_mode = "confirm" if on else "auto"
            app._refresh_footer()
            await app.query_one(ChatLog).add_system(
                f"routing confirm: {'ON (shows tradeoff panel each turn)' if on else 'off'}"
            )

        async def _escalate(app: HarnessApp, args: str) -> None:
            parts = args.strip().split()
            on = parts[0].lower() in {"on", "1", "true", "yes"} if parts else not app._escalate
            app._escalate = on
            if len(parts) > 1:
                try:
                    app._escalate_threshold = float(parts[1])
                except ValueError:
                    pass
            if on:
                app.config.judge_every = 1  # judging must be on for escalation
            await app.query_one(ChatLog).add_system(
                f"escalation: {'on' if on else 'off'} "
                f"(threshold {app._escalate_threshold} · judge_every={app.config.judge_every})"
            )

        async def _edits(app: HarnessApp, args: str) -> None:
            on = args.strip().lower() in {"on", "1", "true", "yes"}
            if not args.strip():
                on = not app._confirm_edits
            app._confirm_edits = on
            await app.query_one(ChatLog).add_system(
                "edit confirmation: "
                + ("ON (review each edit/write diff before it applies)" if on else "off")
            )

        async def _yolo(app: HarnessApp, args: str) -> None:
            a = args.strip().lower()
            if a in {"on", "1", "true", "yes"}:  # YOLO ON = skip permission prompts
                app._ask_permission = False
            elif a in {"off", "0", "false", "no"}:
                app._ask_permission = True
            else:
                app._ask_permission = not app._ask_permission
            if app._ask_permission:
                await app.query_one(ChatLog).add_system(
                    "permissions: ON — you'll be asked before write/edit/bash"
                )
            else:
                await app.query_one(ChatLog).add_error(
                    "YOLO mode: permissions OFF — sensitive tools run without asking"
                )

        async def _thoughts(app: HarnessApp, args: str) -> None:
            a = args.strip().lower()
            if a in {"on", "1", "true", "yes"}:
                on = True
            elif a in {"off", "0", "false", "no"}:
                on = False
            else:
                on = not app._show_thinking
            app._show_thinking = on
            extra = ""
            # Showing thoughts is pointless if the model isn't asked to think — bump the level.
            if on and app.agent.state.thinking_level == "off":
                app.agent.state.thinking_level = "medium"
                app._refresh_footer()
                extra = " (thinking set to medium)"
            msg = (
                f"thoughts: ON — the model's reasoning streams above each answer{extra}"
                if on
                else "thoughts: off"
            )
            await app.query_one(ChatLog).add_system(msg)

        async def _tip(app: HarnessApp, args: str) -> None:
            from minima_harness.tui import tips

            a = args.strip().lower()
            if a in {"off", "0", "false", "no"}:
                app._tips_enabled = False
                await app.query_one(ChatLog).add_system("spinner tips: off")
                return
            if a in {"on", "1", "true", "yes"}:
                app._tips_enabled = True
                await app.query_one(ChatLog).add_system(
                    "spinner tips: ON — a command tip shows beside the loader each turn"
                )
                return
            # No arg: print the next tip on demand and advance the cycle.
            await app.query_one(ChatLog).add_system(tips.format_tip(tips.pick(tips.advance())))

        async def _exit(app: HarnessApp, args: str) -> None:
            app.exit()

        async def _goals(app: HarnessApp, args: str) -> None:
            import time

            a = args.strip()
            low = a.lower()
            if low in ("clear", "done", "stop", "off"):
                app._goals.clear()
                app._goals.save(app.session)
                app._apply_effective_prompt()
                app._refresh_footer()
                await app.query_one(ChatLog).add_system("ledger cleared — back to ad-hoc routing")
                return
            if low.startswith("budget"):
                if not app._goals.active:
                    await app.query_one(ChatLog).add_error("no open ledger — /ledger set <title>")
                    return
                raw = a[6:].strip().lstrip("$")
                try:
                    amount = float(raw) if raw else None
                except ValueError:
                    await app.query_one(ChatLog).add_error("usage: /goals budget <usd> (or blank)")
                    return
                app._goals.set_budget(amount)
                app._goals.save(app.session)
                msg = f"ledger budget set to ${amount:.4f}" if amount else "ledger budget cleared"
                await app.query_one(ChatLog).add_system(msg)
                return
            if low.startswith("set ") or low.startswith("set\t"):
                title = a[3:].strip()
                if not title:
                    await app.query_one(ChatLog).add_error("usage: /goals set <title>")
                    return
                app._goals.start(title, now=time.time())
                app._goals.save(app.session)
                app._apply_effective_prompt()
                app._refresh_footer()
                await app.query_one(ChatLog).add_system(
                    f"ledger opened: {title} — describe the work; I'll plan + track it (with cost)"
                )
                return
            app.push_screen(GoalsOverlay(app._goals.goal))  # no/other args -> view the checklist

        async def _cache(app: HarnessApp, args: str) -> None:
            on = args.strip().lower() in {"on", "1", "true", "yes"}
            if not args.strip():
                on = not app._cache_enabled
            app._cache_enabled = on
            hr = app._cache.hit_rate
            await app.query_one(ChatLog).add_system(
                f"semantic cache: {'ON' if on else 'off'} "
                f"(threshold {app._cache.threshold:.2f} · hit-rate {hr:.0%})"
            )

        async def _stats(app: HarnessApp, args: str) -> None:
            stats = aggregate_sessions(app.cwd)
            await app.query_one(ChatLog).add_system(format_stats(stats))

        async def _recall(app: HarnessApp, args: str) -> None:
            query = args.strip()
            if not query:
                await app.query_one(ChatLog).add_error("usage: /recall <query>")
                return
            sid = app.session.path.stem if app.session.path else None
            results = mubit_recall(query, session_id=sid, limit=5)
            if not results:
                await app.query_one(ChatLog).add_system("(no recall results)")
                return
            lines = []
            for r in results[:5]:
                text = r.get("text", str(r)) if isinstance(r, dict) else str(r)
                lines.append(f"  • {text[:120]}")
            await app.query_one(ChatLog).add_system("Recall:\n" + "\n".join(lines))

        for name, fn, desc in [
            ("quit", _quit, "exit the agent"),
            ("clear", _clear, "clear the transcript"),
            ("banner", _banner, "show / hide the welcome splash"),
            ("cost", _cost, "show the cost meter"),
            ("compact", _compact, "summarize older context"),
            ("help", _help, "list commands"),
            ("model", _model, "pick / pin the model"),
            ("copy", _copy, "copy last reply (or /copy <text>) to clipboard"),
            ("mouse", _mouse, "toggle mouse capture (scroll-wheel vs native text selection)"),
            ("export", _export, "export the conversation to a Markdown file"),
            ("commands", _commands, "open the command palette"),
            ("config", _config, "manage API keys (LLM providers + Mubit)"),
            ("prompt", _prompt, "inspect/edit the system prompt (Mubit + local)"),
            ("optimize", _optimize, "optimize the system prompt via Mubit (save tokens)"),
            ("skills", _skills, "list loaded skills (local + Mubit)"),
            ("confirm", _confirm, "toggle routing confirm gate"),
            ("escalate", _escalate, "toggle quality escalation"),
            ("edits", _edits, "force a diff review for every edit/write"),
            ("yolo", _yolo, "toggle permission prompts (YOLO = off, runs without asking)"),
            ("thoughts", _thoughts, "toggle streaming the model's thinking"),
            ("tip", _tip, "show a command tip (/tip off to silence spinner tips)"),
            ("ledger", _goals, "set/track a budgeted goal + tasks (set <title> · clear · budget)"),
            ("cache", _cache, "toggle semantic response cache"),
            ("exit", _exit, "quit Minima"),
            ("quit", _exit, "quit Minima"),
            ("stats", _stats, "show session analytics (last 10)"),
            ("recall", _recall, "Mubit cross-session recall"),
            ("reconnect", _reconnect, "retry Minima after an offline fallback"),
            ("new", _new, "start a fresh session"),
            ("name", _name, "set the session display name"),
            ("session", _session, "show session info"),
            ("tree", _tree, "view the session tree"),
            ("fork", _fork, "fork from an entry id"),
            ("clone", _clone, "clone the current branch"),
            ("resume", _resume, "resume a session (optionally by id)"),
            ("judge", _judge, "toggle LLM judging on/off"),
            ("theme", _theme, "switch theme (dark|light|file)"),
            ("extensions", _ext_list, "list loaded extensions"),
            ("reload", _reload, "reload extensions + customization"),
        ]:
            reg.register(name, description=desc)(fn)
        # /goals stays as a hidden alias for /ledger (the feature was originally named goals).
        reg.register("goals", description="alias of /ledger", hidden=True)(_goals)
        return reg

    async def _dispatch_command(self, name: str, args: str) -> None:
        cmd = self.commands.get(name)
        if cmd is not None:
            await cmd.handler(self, args)
            return
        # /skill:<name> → load a skill's instructions into the system prompt
        if name.startswith("skill:"):
            sname = name.split(":", 1)[1]
            if sname == "set":
                parts = args.strip().split(None, 1)
                if len(parts) < 2:
                    await self.query_one(ChatLog).add_error(
                        "usage: /skill:set <name> <description>"
                    )
                    return
                from minima_harness.tui.mubit import set_skill

                ok = set_skill(self.cwd, parts[0], parts[1])
                if ok:
                    self._load_customization()
                    await self.query_one(ChatLog).add_system(f"saved Mubit skill: {parts[0]}")
                else:
                    await self.query_one(ChatLog).add_error(f"failed to save skill: {parts[0]}")
                return
            body = self._skills.get(sname)
            if body:
                cur = self.agent.state.system_prompt or ""
                self.agent.state.system_prompt = f"{cur}\n\n# Skill: {sname}\n{body}"
                await self.query_one(ChatLog).add_system(f"loaded skill: {sname}")
                return
            await self.query_one(ChatLog).add_error(f"unknown skill: {sname}")
            return
        # /<template-name> → expand a prompt template into the editor
        body = self._templates.get(name)
        if body:
            text = body if not args.strip() else f"{body}\n{args.strip()}"
            ed = self.query_one(Editor)
            ed.text = text
            ed.move_cursor((0, len(text)))
            await self.query_one(ChatLog).add_system(f"loaded template: /{name} (edit + Enter)")
            return
        await self.query_one(ChatLog).add_error(f"unknown command: /{name}")

    # ------------------------------------------------------------- actions
    async def action_model(self) -> None:
        await self._dispatch_command("model", "")

    async def action_cycle_route_mode(self) -> None:
        cur = self._route_mode if self._route_mode in self.ROUTE_MODES else "auto"
        nxt = self.ROUTE_MODES[(self.ROUTE_MODES.index(cur) + 1) % len(self.ROUTE_MODES)]
        self._route_mode = nxt
        self._refresh_footer()
        note = " · shows the tradeoff panel each turn" if nxt == "confirm" else ""
        await self.query_one(ChatLog).add_system(f"route mode: {nxt}{note}")

    def action_abort(self) -> None:
        self.agent.abort()

    def action_scroll_up(self) -> None:
        self.query_one(ChatLog).scroll_page_up()

    def action_scroll_down(self) -> None:
        self.query_one(ChatLog).scroll_page_down()

    def _scroll_bottom(self) -> None:
        try:
            self.query_one(ChatLog).scroll_end(animate=False)
        except Exception:  # noqa: BLE001 - during teardown the widget may be gone
            pass


def _confidence_band(routing: Any) -> tuple[str, str]:
    """Map a routing decision to a (label, color) confidence signal for the rationale line.

    green = confident and the pick clears tau; amber = thin/uncertain evidence; red = the
    pick doesn't clear tau (or no model met it). Calibrated server-side, so the colour means
    a real probability, not a raw guess.
    """
    chosen_id = routing.chosen_model_id or routing.model.id
    predicted = next(
        (r.predicted_success for r in routing.ranked if r.model_id == chosen_id),
        routing.confidence,
    )
    tau = routing.threshold_used or 0.0
    no_meet = any("no_model_meets_threshold" in w for w in routing.warnings)
    if no_meet or predicted < tau:
        return "low", "red"
    if routing.confidence >= 0.66:
        return "high", "green"
    return "uncertain", "yellow"


def _reasoner_note(routing: Any) -> str:
    """Surface the server-side escalation pathway when it fired (thin/conflicted evidence)."""
    if any(w == "reasoner_consulted" for w in routing.warnings):
        return " · consulted reasoner (thin evidence)"
    if any(w.startswith("escalation_suggested") for w in routing.warnings):
        return " · evidence thin"
    return ""


# Warnings already explained inline on the rationale line (via _reasoner_note / _confidence_band)
# or that are benign config state — kept OFF the top banner so it never falsely reads as
# "routing offline" on a successful route, and only fires on unexpected/actionable conditions.
_INLINE_WARNINGS = (
    "escalation_suggested",
    "reasoner_consulted",
    "reasoner_disabled",
    "no_model_meets_threshold",
)

# Internal routing/recall diagnostics that mean "routing succeeded, just a side-note" — NOT
# user-actionable. These must never render as an alarming red banner (they read exactly like an
# offline/auth error and scared users). Routing still happened; the decision card already shows
# the relevant context ("evidence thin", the chosen model, confidence). Anything NOT listed here
# (or in _INLINE_WARNINGS) is still surfaced, so a genuinely actionable signal — e.g.
# no_model_within_cost_budget / latency_budget, or a future unknown warning — is never hidden.
_BENIGN_WARNINGS = (
    "cold_start",
    "recall_timeout",
    "memory_unavailable",
    "neighbor_classified",
    "llm_classified",
    "prices_stale",
    "thompson_pick",
    "exploration_pick",
    "collapse_guard_applied",
    "thin_evidence",
    "capability_prior",
    "shadow_disagree",
    "durable_fastpath_timeout",
    "reasoner_failed",
)

_HIDDEN_WARNINGS = _INLINE_WARNINGS + _BENIGN_WARNINGS


def _banner_warnings(warnings: list[str]) -> list[str]:
    """Warnings worth surfacing: drop inline-handled + benign diagnostics; keep the rest."""
    return [w for w in warnings if not w.startswith(_HIDDEN_WARNINGS)]


# ROI is "not significant" when a pricier model buys less than this much extra predicted
# success — the cheaper pick is recommended and the premium is framed as poor value.
_ROI_MIN_PP = 0.03  # 3 percentage points


def _chosen_ranking(routing: Any) -> Any:
    chosen_id = routing.chosen_model_id or routing.model.id
    return next((r for r in routing.ranked if r.model_id == chosen_id), None)


def _fmt_cost_range(est: float, low: float | None, high: float | None) -> str:
    """``$0.0123 ($0.0080–$0.0180)`` when a data-grounded band exists, else a honest tag."""
    if low is not None and high is not None:
        return f"${est:.4f} (${low:.4f}–${high:.4f})"
    return f"${est:.4f} (no range yet)"


def _fmt_latency(ms: float | None) -> str:
    return f"~{ms:.0f}ms" if ms else "~?ms"


def _roi_line(routing: Any) -> str:
    """Frame the next-pricier alternative as cost-vs-quality ROI vs the recommended pick."""
    chosen = _chosen_ranking(routing)
    if chosen is None:
        return ""
    pricier = [r for r in routing.ranked if r.est_cost_usd > chosen.est_cost_usd + 1e-9]
    if not pricier:
        return ""
    alt = min(pricier, key=lambda r: r.est_cost_usd)
    dcost = alt.est_cost_usd - chosen.est_cost_usd
    dpp = (alt.predicted_success - chosen.predicted_success) * 100.0
    verdict = "not-significant ROI" if dpp < _ROI_MIN_PP * 100.0 else "worth it for quality"
    return f"{alt.model_id} +${dcost:.4f} for {dpp:+.0f}pp success → {verdict}"


def _routing_reason(routing: Any) -> str:
    """Hybrid reasoning: the reasoner's NL text when escalation fired and produced one;
    otherwise a data-grounded line from the chosen candidate's evidence + an ROI comparison."""
    escalated = any(
        w == "reasoner_consulted" or w.startswith("escalation_suggested") for w in routing.warnings
    )
    if escalated and routing.rationale.strip():
        return routing.rationale.strip()
    chosen = _chosen_ranking(routing)
    if chosen is None:
        return routing.rationale.strip()
    n = chosen.evidence_count
    if n > 0:
        base = (
            f"{n} similar task{'s' if n != 1 else ''} · {chosen.model_id} succeeds "
            f"{chosen.predicted_success:.0%} at ~${chosen.est_cost_usd:.4f}"
        )
    else:
        base = (
            f"{chosen.model_id} · capability prior {chosen.predicted_success:.0%} "
            f"at ~${chosen.est_cost_usd:.4f}"
        )
    roi = _roi_line(routing)
    return f"{base} · {roi}" if roi else base


def _args_repr(args: Any) -> str:
    try:
        if hasattr(args, "model_dump_json"):
            return args.model_dump_json()
        return str(args)
    except Exception:  # noqa: BLE001
        return ""


_TOOL_PREVIEW_LINES = 18


def _as_dict(args: Any) -> dict:
    if isinstance(args, dict):
        return args
    if hasattr(args, "model_dump"):
        try:
            return args.model_dump()
        except Exception:  # noqa: BLE001
            return {}
    return getattr(args, "__dict__", {}) or {}


def _clip(text: str, limit: int = 200) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _preview(body: str, prefix: str, *, max_lines: int = _TOOL_PREVIEW_LINES) -> str:
    lines = body.splitlines()
    shown = "\n".join(f"{prefix}{ln}" for ln in lines[:max_lines])
    extra = len(lines) - max_lines
    if extra > 0:
        shown += f"\n  … (+{extra} more line{'s' if extra != 1 else ''})"
    return shown


def _format_tool_call(name: str, args: Any) -> str:
    """Render a tool call as a clean, IDE-like summary instead of a raw JSON args dump.

    write -> "path (new file, N lines)" + a + prefixed preview; edit -> a unified diff of the
    change; read -> path + range; bash -> the command; others -> compact key=value. Falls back
    to the raw repr for anything unexpected so nothing is ever hidden."""
    a = _as_dict(args)
    if not a:
        return _clip(_args_repr(args), 300)
    if name == "write":
        path = a.get("path", "?")
        lines = (a.get("content") or "").splitlines()
        n = len(lines)
        head = f"{path}  (new file, {n} line{'s' if n != 1 else ''})"
        return f"{head}\n{_preview(a.get('content') or '', '+')}" if n else head
    if name == "edit":
        from types import SimpleNamespace

        from minima_harness.tui.diff import render_tool_diff

        path = a.get("path", "?")
        diff = render_tool_diff("edit", SimpleNamespace(**a))
        body = "\n".join(ln for ln in diff.splitlines() if not ln.startswith(("--- ", "+++ ")))
        tag = "  (replace all)" if a.get("replace_all") else ""
        return f"{path}{tag}\n{_preview(body, '', max_lines=24)}"
    if name == "apply_patch":
        from minima_harness.tools.apply_patch import summarize_patch

        return summarize_patch(a.get("patch") or "")
    if name == "read":
        path = a.get("path", "?")
        off = a.get("offset") or 1
        return f"{path}" + (f"  (from line {off})" if off and off != 1 else "")
    if name == "bash":
        return f"$ {_clip(a.get('command') or '', 200)}"
    if name == "tasks":
        op = a.get("op", "")
        if op == "set":
            items = a.get("tasks") or []
            marks = {"completed": "[x]", "in_progress": "[~]", "blocked": "[!]"}
            head = f"plan {len(items)} task{'s' if len(items) != 1 else ''}:"
            rows = [
                f"  {marks.get(str(it.get('status', '')), '[ ]')} "
                f"{_clip(str(it.get('content', '')), 80)}"
                for it in items[:_TOOL_PREVIEW_LINES]
            ]
            return "\n".join([head, *rows])
        if op == "update":
            return f"{a.get('task_id', '?')} → {a.get('status', '?')}"
        return "list tasks"
    if name in ("ls", "grep", "find"):
        salient = a.get("pattern") or a.get("path") or a.get("query") or ""
        return _clip(str(salient), 160) if salient else _kv(a)
    return _kv(a)


def _kv(a: dict) -> str:
    return " · ".join(f"{k}={_clip(str(v), 80)}" for k, v in a.items())


def _snippet(text: str, limit: int = 120) -> str:
    flat = (text or "").replace("\n", " ").strip()
    return flat[:limit] + ("…" if len(flat) > limit else "")


def _conversation_to_markdown(messages: list) -> str:
    """Render the agent's message history as clean Markdown (for /export)."""
    parts = ["# minima-harness conversation\n"]
    for m in messages:
        if m.role == "user":
            parts.append(f"\n## You\n\n{m.text}\n")
        elif m.role == "assistant":
            parts.append(f"\n## Assistant\n\n{m.text}\n")
            for call in getattr(m, "tool_calls", []):
                parts.append(f"\n```tool:{call.name}\n{_args_repr(call.arguments)}\n```\n")
        elif m.role == "toolResult":
            block = (
                "\n<details><summary>tool result</summary>\n\n"
                f"```\n{_snippet(m.text, 2000)}\n```\n\n"
                "</details>\n"
            )
            parts.append(block)
    return "\n".join(parts)
