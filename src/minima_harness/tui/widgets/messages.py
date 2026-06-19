from __future__ import annotations

import time

from rich.text import Text
from textual.containers import ScrollableContainer
from textual.widgets import Static

from minima_harness.tui.theme import get_theme

THROTTLE_S = 0.03

_ROLE_COLOR = {"user": "user", "assistant": "assistant", "tool": "tool"}
_ROLE_PREFIX = {"user": "▸ ", "assistant": "", "tool": "", "error": "✗ ", "system": ""}


class MessageBubble(Static):
    """A single chat message. Appendable + throttled for live assistant streaming."""

    def __init__(self, role: str, text: str = "", *, prefix: str | None = None) -> None:
        self._role = role
        theme = get_theme("dark")
        self._color = theme.get(_ROLE_COLOR.get(role, "muted"), theme["assistant"])
        self._prefix = prefix if prefix is not None else _ROLE_PREFIX.get(role, "")
        self._buf = text
        self._last_flush = 0.0
        super().__init__(self._content_text())

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

        self._last_flush = time.monotonic()
        try:
            self.update(Markdown(self._buf))
        except Exception:  # noqa: BLE001 - fall back to plain text if markdown rendering fails
            self.flush()

    def _content_text(self) -> Text:
        return Text(f"{self._prefix}{self._buf}", style=self._color)


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

    async def add_tool(self, name: str, args_repr: str = "") -> MessageBubble:
        return await self._add(MessageBubble("tool", args_repr, prefix=f"◆ {name}  "))

    async def add_tool_result(self, summary: str, is_error: bool) -> MessageBubble:
        role = "error" if is_error else "system"
        return await self._add(MessageBubble(role, summary, prefix="   → "))

    async def add_error(self, message: str) -> MessageBubble:
        return await self._add(MessageBubble("error", message))

    async def add_system(self, text: str) -> MessageBubble:
        return await self._add(MessageBubble("system", text))
