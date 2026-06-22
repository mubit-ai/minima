from __future__ import annotations

import inspect
import logging
from pathlib import Path
from typing import Any

from rich.text import Text
from textual.app import App, ComposeResult
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
from minima_harness.tui.bridge import EventBridge
from minima_harness.tui.clipboard import copy_to_clipboard
from minima_harness.tui.commands import CommandRegistry
from minima_harness.tui.compaction import summarize
from minima_harness.tui.editor import parse_submission, run_bash
from minima_harness.tui.extensions import load_extensions
from minima_harness.tui.history import History, append_history, load_history
from minima_harness.tui.overlays import ModelPicker, SessionPicker, TreePicker
from minima_harness.tui.widgets.banner import render_banner
from minima_harness.tui.widgets.editor import Editor
from minima_harness.tui.widgets.footer import render_footer
from minima_harness.tui.widgets.messages import ChatLog, MessageBubble

_log = logging.getLogger("minima_harness.tui.app")


class HarnessApp(App):
    BINDINGS = [
        ("ctrl+l", "model", "Model"),
        ("escape", "abort", "Abort"),
        ("ctrl+c,ctrl+c", "quit", "Quit"),
    ]
    CSS = """
    Screen { layout: vertical; }
    #chatlog { height: 1fr; border: round $accent; padding: 0 1; }
    #banner { height: auto; }
    #editor { height: 5; }
    #cmd-popup {
        display: none; height: auto; max-height: 8;
        border: round $accent; background: $panel;
    }
    #cmd-popup.visible { display: block; }
    ModelPicker, TreePicker, SessionPicker { align: center middle; }
    ModelPicker OptionList { width: 60; height: 14; border: round $accent; }
    SessionPicker OptionList { width: 60; height: 14; border: round $accent; }
    TreePicker Tree { width: 70; height: 16; border: round $accent; }
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
        self.agent = agent or MinimaAgent(
            self.config, tools=self._tools, meter=CostMeter(), system_prompt=system_prompt
        )
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
        self._load_customization()
        self._apply_extensions()

    def _load_customization(self) -> None:
        from minima_harness.tui.customize import load_skills, load_templates
        from minima_harness.tui.theme import reload_file_themes

        reload_file_themes(self.cwd)
        self._templates = load_templates(self.cwd)
        self._skills = load_skills(self.cwd)

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
        yield TextualFooter()

    def on_mount(self) -> None:
        self.title = "minima-harness"
        self.agent.subscribe(self.bridge)
        self.agent.subscribe(self._extension_fanout)
        self.bridge.bind(on_text=self._append_stream)
        self.query_one(Editor).prompt_history = self._history
        self.query_one(Editor).focus()
        self._refresh_footer()
        if self._load_session_on_mount and self.session.entries:
            self.run_worker(self._load_session(self.session), exclusive=True)

    # ------------------------------------------------------------- streaming
    def _append_stream(self, delta: str) -> None:
        if self._working:
            self._working = False
            self.query_one("#banner", Static).update(Text(""))
        if self._stream_bubble is not None:
            self._stream_bubble.append(delta)

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
        self._working = True
        self.query_one("#banner", Static).update(Text("working…"))
        routing = None
        try:
            routing = await self.agent.prompt(text)
        except Exception as exc:  # noqa: BLE001
            self._working = False
            await chatlog.add_error(str(exc))
            self._set_banner(str(exc))
            self._stream_bubble = None
            return
        await self._render_tools_post_turn()
        if self._stream_bubble is not None:
            self._stream_bubble.render_markdown()
            self.session.append(EntryType.ASSISTANT, {"text": self._stream_bubble.buffer})
            self._stream_bubble = None
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
        self._working = False
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
        self.title = f"minima-harness · {session_label}"
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
        self.sub_title = footer.plain

    # ------------------------------------------------------------- commands
    def _build_commands(self) -> CommandRegistry:
        reg = CommandRegistry()

        async def _quit(app: HarnessApp, args: str) -> None:
            app.exit()

        async def _clear(app: HarnessApp, args: str) -> None:
            await app.query_one(ChatLog).remove_children()

        async def _cost(app: HarnessApp, args: str) -> None:
            meter = app.agent.meter
            await app.query_one(ChatLog).add_system(meter.report() if meter else "(no meter)")

        async def _help(app: HarnessApp, args: str) -> None:
            await app.query_one(ChatLog).add_system(app.commands.help_text())

        async def _model(app: HarnessApp, args: str) -> None:
            cands = list(app.config.candidates or [])
            current = app.agent.state.model.id if app.agent.state.model is not None else None

            def _picked(chosen: str | None) -> None:
                if chosen:
                    app.config.candidates = [chosen]  # pin: Minima must route to this model
                    app._footer_state["model"] = chosen
                    app._footer_state["basis"] = "pinned"
                    app._refresh_footer()  # reflect the pin at the top immediately

            app.push_screen(ModelPicker(cands, current), callback=_picked)

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

            app.push_screen(ModelPicker(sorted(avail), cur), callback=_picked)

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
            text = args.strip()
            if not text:
                last = app.agent._last_assistant()
                text = last.text if last is not None else ""
            if not text:
                await app.query_one(ChatLog).add_system("nothing to copy yet")
                return
            if copy_to_clipboard(text):
                await app.query_one(ChatLog).add_system(f"copied {len(text)} char(s) to clipboard")
            else:
                await app.query_one(ChatLog).add_error(
                    "no clipboard tool found (install pbcopy/xclip/xsel)"
                )

        for name, fn, desc in [
            ("quit", _quit, "exit the agent"),
            ("clear", _clear, "clear the transcript"),
            ("cost", _cost, "show the cost meter"),
            ("compact", _compact, "summarize older context"),
            ("help", _help, "list commands"),
            ("model", _model, "pick / pin the model"),
            ("copy", _copy, "copy last reply (or /copy <text>) to clipboard"),
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
