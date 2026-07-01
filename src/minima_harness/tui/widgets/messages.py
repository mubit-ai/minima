from __future__ import annotations

import time

from rich.text import Text
from textual.containers import ScrollableContainer
from textual.widgets import Static

from minima_harness.tui.theme import current_theme, get_theme

# Min seconds between live-stream repaints (~16 Hz). The terminal emulator repaints the whole
# chat region on each flush, so a tighter cadence (e.g. 0.03 = 33 Hz) drives terminal CPU/fans
# hard for no readability gain. 16 Hz still reads as smooth streaming.
THROTTLE_S = 0.06

_ROLE_COLOR = {"user": "user", "assistant": "assistant", "tool": "tool", "thinking": "muted"}
_ROLE_PREFIX = {
    "user": "▸ ",
    "assistant": "",
    "tool": "",
    "error": "✗ ",
    "system": "",
    "thinking": "thoughts  ",
}


def _color_for(role: str) -> str:
    t = get_theme(current_theme())
    return t.get(_ROLE_COLOR.get(role, "muted"), t["assistant"])


class MessageBubble(Static):
    """A single chat message. Appendable + throttled for live assistant streaming."""

    def __init__(
        self,
        role: str,
        text: str = "",
        *,
        prefix: str | None = None,
        color: str | None = None,
        italic: bool = False,
    ) -> None:
        self._role = role
        self._color_override = color
        self._color = color or _color_for(role)
        self._italic = italic
        self._prefix = prefix if prefix is not None else _ROLE_PREFIX.get(role, "")
        self._buf = text
        self._last_flush = 0.0
        self._markdown = False
        super().__init__(self._content_text())

    def _style(self) -> str:
        return f"italic {self._color}" if self._italic else self._color

    @property
    def buffer(self) -> str:
        return self._buf

    def append(self, delta: str) -> None:
        self._buf += delta
        if time.monotonic() - self._last_flush >= THROTTLE_S:
            self.flush()

    def set_text(self, text: str) -> None:
        self._buf = text
        self.flush()

    def flush(self) -> None:
        self._last_flush = time.monotonic()
        try:
            self.update(self._content_text())
        except Exception:  # noqa: BLE001 - not mounted / no active app; buffer stays current
            pass

    def render_markdown(self) -> None:
        """Swap the bubble's plain-streamed text for rendered Markdown (assistant finalize)."""
        from rich.markdown import Markdown

        self._markdown = True
        self._last_flush = time.monotonic()
        try:
            self.update(Markdown(self._buf))
        except Exception:  # noqa: BLE001 - fall back to plain text if markdown rendering fails
            self.flush()

    def refresh_theme(self) -> None:
        """Re-read the active palette and re-render (used after /theme)."""
        self._color = self._color_override or _color_for(self._role)
        if self._markdown:
            self.render_markdown()
        else:
            self.flush()

    def _content_text(self) -> Text:
        if self._role == "tool" and "\n" in self._buf:
            return self._tool_diff_text()
        return Text(f"{self._prefix}{self._buf}", style=self._style())

    def _tool_diff_text(self) -> Text:
        """Colorize a multi-line tool-call body like an IDE diff: + green, - red, @@ cyan."""
        t = Text()
        lines = f"{self._prefix}{self._buf}".split("\n")
        for i, line in enumerate(lines):
            body = line + ("" if i == len(lines) - 1 else "\n")
            s = line.lstrip()
            if s.startswith("+") and not s.startswith("+++"):
                t.append(body, style="green")
            elif s.startswith("-") and not s.startswith("---"):
                t.append(body, style="red")
            elif s.startswith("@@"):
                t.append(body, style="cyan")
            else:
                t.append(body, style=self._color)
        return t


class ChatLog(ScrollableContainer):
    """Scrolling list of message bubbles; auto-scrolls to the newest."""

    async def _add(self, bubble: MessageBubble) -> MessageBubble:
        await self.mount(bubble)
        self.scroll_end(animate=False)
        return bubble

    async def add_user(self, text: str) -> MessageBubble:
        return await self._add(MessageBubble("user", text))

    async def add_assistant_stream(self) -> MessageBubble:
        return await self._add(MessageBubble("assistant"))

    async def add_thinking_stream(self) -> MessageBubble:
        """A muted, 💭-prefixed bubble that streams the model's reasoning (when /thoughts is on)."""
        return await self._add(MessageBubble("thinking", italic=True))

    async def add_tool(self, name: str, args_repr: str = "") -> MessageBubble:
        return await self._add(MessageBubble("tool", args_repr, prefix=f"◆ {name}  "))

    async def add_tool_result(self, summary: str, is_error: bool) -> MessageBubble:
        # A failed tool (incl. permission/sandbox denials) reads as a prominent red ✗ line, not
        # a faint "→" that's easy to miss; a success stays a quiet dim snippet.
        role = "error" if is_error else "system"
        prefix = "   ✗ " if is_error else "   → "
        return await self._add(MessageBubble(role, summary, prefix=prefix))

    async def add_error(self, message: str) -> MessageBubble:
        return await self._add(MessageBubble("error", message))

    async def add_system(self, text: str, *, color: str | None = None) -> MessageBubble:
        return await self._add(MessageBubble("system", text, color=color))
