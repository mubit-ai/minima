from __future__ import annotations

import inspect
import logging
from pathlib import Path
from typing import Any

import anyio
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
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
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.session import SessionManager, SessionStore
from minima_harness.session.format import EntryType
from minima_harness.tools import default_toolset
from minima_harness.tui.analytics import aggregate_sessions, format_stats
from minima_harness.tui.bridge import EventBridge
from minima_harness.tui.clipboard import copy_to_clipboard
from minima_harness.tui.commands import CommandRegistry
from minima_harness.tui.compaction import summarize
from minima_harness.tui.context import get_session_override, set_session_override
from minima_harness.tui.editor import parse_submission, run_bash
from minima_harness.tui.extensions import load_extensions
from minima_harness.tui.history import History, append_history, load_history
from minima_harness.tui.mubit import (
    effective_prompt,
    init_mubit,
    token_breakdown,
)
from minima_harness.tui.mubit import (
    recall as mubit_recall,
)
from minima_harness.tui.mubit import (
    set_prompt as mubit_set_prompt,
)
from minima_harness.tui.overlays import (
    CommandPicker,
    ModelPicker,
    PromptInspector,
    RoutingConfirm,
    SessionPicker,
    TreePicker,
)
from minima_harness.tui.widgets.banner import render_banner
from minima_harness.tui.widgets.editor import Editor
from minima_harness.tui.widgets.footer import render_footer
from minima_harness.tui.widgets.messages import ChatLog, MessageBubble
from minima_harness.tui.widgets.status import StatusBar

_log = logging.getLogger("minima_harness.tui.app")


class HarnessApp(App):
    BINDINGS = [
        ("ctrl+l", "model", "Model"),
        ("escape", "abort", "Abort"),
        ("ctrl+c,ctrl+c", "quit", "Quit"),
        Binding("pageup", "scroll_up", "PgUp", priority=True),
        Binding("pagedown", "scroll_down", "PgDn", priority=True),
    ]
    CSS = """
    Screen { layout: vertical; }
    #chatlog { height: 1fr; background: $boost; padding: 0 1; }
    #banner { height: auto; padding: 0 1; }
    #editor { height: 5; background: $panel; padding: 0 1; }
    #status { height: 1; background: $panel; padding: 0 1; color: $text-muted; }
    #cmd-popup {
        display: none; height: auto; max-height: 8;
        background: $panel; padding: 0 1;
    }
    #cmd-popup.visible { display: block; }
    ModelPicker, TreePicker, SessionPicker, CommandPicker { align: center middle; }
    ModelPicker OptionList, SessionPicker OptionList, CommandPicker OptionList, TreePicker Tree {
        background: $panel; padding: 0 1;
    }
    ModelPicker OptionList { width: 60; height: 14; }
    SessionPicker OptionList { width: 60; height: 14; }
    CommandPicker OptionList { width: 64; height: 16; }
    PromptInspector { align: center middle; }
    PromptInspector TextArea { width: 80; height: 20; background: $panel; }
    TreePicker Tree { width: 70; height: 16; }
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
    ) -> None:
        super().__init__()
        self.config = config
        self.config.judge_every = judge_every  # default OFF in interactive mode
        self.session = session
        self.cwd = cwd or Path.cwd()
        self._tools = list(tools or default_toolset())
        self._confirm_route = False
        self._escalate = False
        self._escalate_threshold = 0.7
        self.agent = agent or MinimaAgent(
            self.config, tools=self._tools, meter=CostMeter(), system_prompt=system_prompt
        )
        self.agent.before_route = self._route_hook
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

    def on_mount(self) -> None:
        self.title = "minima-harness"
        self.agent.subscribe(self.bridge)
        self.agent.subscribe(self._extension_fanout)
        self.bridge.bind(on_text=self._append_stream, on_thinking=self._on_thinking)
        self.query_one(Editor).prompt_history = self._history
        self.query_one(Editor).focus()
        self._refresh_footer()
        self._apply_effective_prompt()
        self.run_worker(self._show_welcome(), exclusive=True)

    def _apply_effective_prompt(self) -> None:
        """Recompute and apply the Mubit+local+session system prompt to the agent."""
        self.agent.state.system_prompt = effective_prompt(
            self.cwd, get_session_override(self.session)
        )

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
        chatlog.scroll_end(animate=False)
        if self._load_session_on_mount and self.session.entries:
            self.run_worker(self._load_session(self.session), exclusive=True)

    # ------------------------------------------------------------- streaming
    def _set_state(self, state: str) -> None:
        try:
            self.query_one(StatusBar).set_state(state)
        except Exception:  # noqa: BLE001 - during teardown the widget may be gone
            pass

    def _append_stream(self, delta: str) -> None:
        self._set_state("working")
        if self._stream_bubble is not None:
            self._stream_bubble.append(delta)

    def _on_thinking(self, delta: str) -> None:
        self._set_state("thinking")

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

    async def _route_hook(self, routing: Any, task_text: str) -> Any:
        """before_route hook: always emits a rationale line; shows confirm panel when on."""
        chatlog = self.query_one(ChatLog)
        if routing is not None:
            chosen = routing.chosen_model_id or routing.model.id
            await chatlog.add_system(
                f"▸ routed to {chosen} · basis {routing.decision_basis} "
                f"· est ${routing.est_cost_usd:.4f}"
            )
        if not self._confirm_route or routing is None:
            return None  # accept as-is
        result = await self.push_screen(RoutingConfirm(routing), wait_for_dismiss=True)
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
        if action == "pin" and chosen_id:
            self.config.candidates = [chosen_id]
        return routing

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
        self.query_one("#banner", Static).update(Text(f"thinking: {nxt}"))

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
        await chatlog.add_user(text)
        self.session.append(EntryType.USER, {"text": text})
        self._stream_bubble = await chatlog.add_assistant_stream()
        self._set_state("routing")
        routing = None
        try:
            routing = await self.agent.prompt(text)
        except Exception as exc:  # noqa: BLE001
            self._set_state("idle")
            await chatlog.add_error(str(exc))
            self._set_banner(str(exc))
            self._stream_bubble = None
            return
        await self._render_tools_post_turn()
        if self._stream_bubble is not None:
            self._stream_bubble.render_markdown()
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
                },
            )
            self._stream_bubble = None
        self._scroll_bottom()
        if self._escalate and routing is not None:
            await self._check_escalate(routing, text)
        self._after_turn(routing)

    async def _render_tools_post_turn(self) -> None:
        chatlog = self.query_one(ChatLog)
        for msg in self.agent.state.messages[self._rendered_msgs :]:
            if isinstance(msg, AssistantMessage):
                for call in msg.tool_calls:
                    await chatlog.add_tool(call.name, _args_repr(call.arguments))
            elif msg.role == "toolResult":
                await chatlog.add_tool_result(_snippet(msg.text), msg.is_error)
        self._rendered_msgs = len(self.agent.state.messages)

    async def _load_session(self, store: SessionStore) -> None:
        """Switch the active session and rebuild the agent context + transcript from it."""
        self.session = store
        chatlog = self.query_one(ChatLog)
        await chatlog.remove_children()
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
            self._routing_offline = True
            self._set_banner("Minima unreachable — using the current model")
        else:
            self._footer_state = self._routing_footer_state(routing)
            if routing.warnings:
                self._set_banner("; ".join(routing.warnings[:2]))
            elif self._footer_state["ctx_pct"] > 80:
                self._set_banner("context near limit — /compact to free space")
            else:
                self.query_one("#banner", Static).update(Text(""))
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

    def _refresh_footer(self) -> None:
        meter = self.agent.meter or CostMeter()
        session_label = self.session.display_name or (
            self.session.path.stem if self.session.path else "ephemeral"
        )
        self.title = "minima-harness"
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
        )
        self.sub_title = ""
        try:
            self.query_one(StatusBar).set_idle_text(footer.plain)
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

        async def _cost(app: HarnessApp, args: str) -> None:
            meter = app.agent.meter
            await app.query_one(ChatLog).add_system(meter.report() if meter else "(no meter)")

        async def _help(app: HarnessApp, args: str) -> None:
            await app.query_one(ChatLog).add_system(app.commands.help_text())

        async def _model(app: HarnessApp, args: str) -> None:
            from minima_harness.ai import all_models

            cands = list(app.config.candidates or [])
            providers = {m.id: m.provider for m in all_models()}
            active = app._footer_state.get("model")
            basis = app._footer_state.get("basis")
            pinned = cands[0] if len(cands) == 1 else None

            def _picked(chosen: str | None) -> None:
                if chosen:
                    app.config.candidates = [chosen]  # pin: Minima must route to this model
                    app._footer_state["model"] = chosen
                    app._footer_state["basis"] = "pinned"
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
            app._routing_offline = False
            app.query_one("#banner", Static).update(Text(""))
            await app.query_one(ChatLog).add_system("reconnected (next turn routes via Minima)")

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
            ok = await anyio.to_thread.run_sync(copy_to_clipboard, text)
            if ok:
                await app.query_one(ChatLog).add_system(f"copied {len(text)} char(s) to clipboard")
            else:
                fd, path = tempfile.mkstemp(suffix=".txt", prefix="minima-harness-")
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(text)
                await app.query_one(ChatLog).add_error(
                    f"clipboard unavailable — wrote {len(text)} char(s) to {path}"
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
            tokens = token_breakdown(app.cwd, app.agent.state.messages)
            prompt_text = effective_prompt(app.cwd, get_session_override(app.session))

            def _saved(result: dict | None) -> None:
                if result:
                    app.run_worker(app._apply_prompt_edit(result), exclusive=True)

            app.push_screen(PromptInspector(prompt_text, tokens), callback=_saved)

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
                on = not app._confirm_route
            app._confirm_route = on
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
            ("cost", _cost, "show the cost meter"),
            ("compact", _compact, "summarize older context"),
            ("help", _help, "list commands"),
            ("model", _model, "pick / pin the model"),
            ("copy", _copy, "copy last reply (or /copy <text>) to clipboard"),
            ("export", _export, "export the conversation to a Markdown file"),
            ("commands", _commands, "open the command palette"),
            ("prompt", _prompt, "inspect/edit the system prompt (Mubit + local)"),
            ("skills", _skills, "list loaded skills (local + Mubit)"),
            ("confirm", _confirm, "toggle routing confirm gate"),
            ("escalate", _escalate, "toggle quality escalation"),
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


def _args_repr(args: Any) -> str:
    try:
        if hasattr(args, "model_dump_json"):
            return args.model_dump_json()
        return str(args)
    except Exception:  # noqa: BLE001
        return ""


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
