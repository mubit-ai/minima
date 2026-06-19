from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from minima_harness.agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    ToolExecutionUpdateEvent,
    TurnEndEvent,
    TurnStartEvent,
)
from minima_harness.ai.events import TextDeltaEvent

_log = logging.getLogger("minima_harness.tui.bridge")


@dataclass
class EventBridge:
    """Agent subscribe-listener that turns AgentEvents into a renderable transcript model.

    The app passes ``on_*`` callbacks (wired to widgets) via :meth:`bind`; absent
    callbacks are no-ops so the bridge is unit-testable in isolation.
    """

    assistant_text: str = field(default="")
    tools: list[dict[str, Any]] = field(default_factory=list)
    turns: int = 0
    finished: bool = False
    error: str | None = None

    def __post_init__(self) -> None:
        self._on_text = None
        self._on_tool_start = None
        self._on_tool_end = None
        self._on_turn = None
        self._on_finish = None

    def bind(
        self,
        *,
        on_text=None,
        on_tool_start=None,
        on_tool_end=None,
        on_turn=None,
        on_finish=None,
    ) -> None:
        self._on_text = on_text
        self._on_tool_start = on_tool_start
        self._on_tool_end = on_tool_end
        self._on_turn = on_turn
        self._on_finish = on_finish

    def _safe(self, cb, *args) -> None:
        if cb is None:
            return
        try:
            cb(*args)
        except Exception:  # noqa: BLE001 - the hot path must never break on rendering
            _log.warning("bridge_callback_failed", exc_info=True)

    async def __call__(self, event) -> None:  # noqa: ANN001 - AgentEvent union
        if isinstance(event, AgentStartEvent):
            self.assistant_text = ""
            self.tools = []
            self.turns = 0
            self.finished = False
        elif isinstance(event, TurnStartEvent):
            pass
        elif isinstance(event, MessageStartEvent):
            pass
        elif isinstance(event, MessageUpdateEvent):
            stream = event.assistant_message_event
            if isinstance(stream, TextDeltaEvent) and stream.delta:
                self.assistant_text += stream.delta
                self._safe(self._on_text, stream.delta)
        elif isinstance(event, MessageEndEvent):
            pass
        elif isinstance(event, ToolExecutionStartEvent):
            rec = {"id": event.tool_call_id, "name": event.tool_name, "args": event.args}
            self.tools.append(rec)
            self._safe(self._on_tool_start, rec)
        elif isinstance(event, ToolExecutionUpdateEvent):
            pass
        elif isinstance(event, ToolExecutionEndEvent):
            self._safe(self._on_tool_end, event.tool_call_id, event.result, event.is_error)
        elif isinstance(event, TurnEndEvent):
            self.turns += 1
            self._safe(self._on_turn, event)
        elif isinstance(event, AgentEndEvent):
            self.finished = True
            self._safe(self._on_finish, event)
