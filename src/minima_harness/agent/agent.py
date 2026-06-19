"""The stateful Agent — a port of PI's ``pi-agent-core`` ``Agent`` class.

Wraps :func:`agent_loop` with: persistent state across prompts, ordered awaited
subscribers, abort via an anyio cancel scope, and steering/follow-up queues injected
between turns. ``prompt()`` awaits the full run inline (matching PI); for background use
launch it in a task and await :meth:`wait_for_idle`.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any

import anyio

from minima_harness.agent.events import AgentEvent
from minima_harness.agent.loop import agent_loop
from minima_harness.agent.state import (
    AgentLoopConfig,
    AgentState,
    ConvertToLlm,
    TransformContext,
    default_convert_to_llm,
)
from minima_harness.agent.tools import (
    AfterToolCall,
    BeforeToolCall,
    ThinkingLevel,
    ToolExecutionMode,
)
from minima_harness.ai.types import ContentBlock, Message, Model

Listener = Callable[[AgentEvent], Any]


class Agent:
    def __init__(
        self,
        *,
        model: Model,
        system_prompt: str | None = None,
        tools: list | None = None,
        messages: list[Message] | None = None,
        thinking_level: ThinkingLevel = "off",
        convert_to_llm: ConvertToLlm = default_convert_to_llm,
        transform_context: TransformContext | None = None,
        tool_execution: ToolExecutionMode = "parallel",
        before_tool_call: BeforeToolCall | None = None,
        after_tool_call: AfterToolCall | None = None,
        thinking_budgets: dict[str, int] | None = None,
        max_turns: int = 50,
        session_id: str | None = None,
        stream_options: dict[str, Any] | None = None,
        steering_mode: str = "one-at-a-time",
        follow_up_mode: str = "one-at-a-time",
        should_stop_after_turn: Any = None,
    ) -> None:
        self._state = AgentState(
            system_prompt=system_prompt,
            model=model,
            thinking_level=thinking_level,
            tools=list(tools or []),
            messages=list(messages or []),
            steering_mode=steering_mode,
            follow_up_mode=follow_up_mode,
        )
        self._convert_to_llm = convert_to_llm
        self._transform_context = transform_context
        self._tool_execution = tool_execution
        self._before_tool_call = before_tool_call
        self._after_tool_call = after_tool_call
        self._thinking_budgets = thinking_budgets
        self._max_turns = max_turns
        self._session_id = session_id
        self._stream_options = stream_options
        self._should_stop_after_turn = should_stop_after_turn
        self._listeners: list[Listener] = []
        self._cancel_scope: anyio.CancelScope | None = None
        self._idle = asyncio.Event()
        self._idle.set()

    # ----------------------------------------------------------------- state

    @property
    def state(self) -> AgentState:
        return self._state

    def reset(self) -> None:
        """Clear the conversation + error; keep model, tools, system prompt."""
        self._state.messages = []
        self._state.streaming_message = None
        self._state.error_message = None
        self._state.pending_tool_calls.clear()

    # ----------------------------------------------- mutators (PI-style attrs)

    @property
    def tool_execution(self) -> ToolExecutionMode:
        return self._tool_execution

    @tool_execution.setter
    def tool_execution(self, value: ToolExecutionMode) -> None:
        self._tool_execution = value

    @property
    def before_tool_call(self) -> BeforeToolCall | None:
        return self._before_tool_call

    @before_tool_call.setter
    def before_tool_call(self, value: BeforeToolCall | None) -> None:
        self._before_tool_call = value

    @property
    def after_tool_call(self) -> AfterToolCall | None:
        return self._after_tool_call

    @after_tool_call.setter
    def after_tool_call(self, value: AfterToolCall | None) -> None:
        self._after_tool_call = value

    @property
    def session_id(self) -> str | None:
        return self._session_id

    @session_id.setter
    def session_id(self, value: str | None) -> None:
        self._session_id = value

    @property
    def thinking_budgets(self) -> dict[str, int] | None:
        return self._thinking_budgets

    @thinking_budgets.setter
    def thinking_budgets(self, value: dict[str, int] | None) -> None:
        self._thinking_budgets = value

    # ------------------------------------------------------------- subscribe

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """Register a listener (sync or async). Returns an unsubscribe callable."""
        self._listeners.append(listener)

        def _unsubscribe() -> None:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

        return _unsubscribe

    async def _dispatch(self, event: AgentEvent) -> None:
        for listener in list(self._listeners):
            result = listener(event)
            if inspect.isawaitable(result):
                await result

    # ----------------------------------------------------------- prompting

    async def prompt(self, content: str | list[ContentBlock] | Message | list[Any]) -> None:
        """Run the loop with ``content`` appended as a user turn. Awaits completion."""
        await self._run(self._coerce_prompts(content))

    async def continue_(self) -> None:
        """Resume from current context without a new user message."""
        if self._state.messages and self._state.messages[-1].role == "assistant":
            raise ValueError("continue_() requires the last message to be user or toolResult")
        await self._run([])

    async def _run(self, prompts: list[Message]) -> None:
        if self._state.is_streaming:
            raise RuntimeError("agent is already running")
        self._idle.clear()
        self._state.is_streaming = True
        self._state.error_message = None
        scope = anyio.CancelScope()
        try:
            with scope:
                self._cancel_scope = scope
                config = self._build_config()
                async for event in agent_loop(prompts, self._state, config):
                    await self._dispatch(event)
            if scope.cancelled_caught:
                if self._state.error_message is None:
                    self._state.error_message = "aborted"
        finally:
            self._cancel_scope = None
            self._state.is_streaming = False
            self._state.streaming_message = None
            self._idle.set()

    def abort(self) -> None:
        """Cancel the in-flight run (if any). No-op when idle."""
        if self._cancel_scope is not None:
            self._cancel_scope.cancel()

    async def wait_for_idle(self) -> None:
        """Await the current run's completion (for background-task usage)."""
        await self._idle.wait()

    # ----------------------------------------------------- steering/follow-up

    def steer(self, message: Message | str) -> None:
        self._state.steering.append(self._as_message(message))

    def follow_up(self, message: Message | str) -> None:
        self._state.follow_up.append(self._as_message(message))

    def clear_steering_queue(self) -> None:
        self._state.steering.clear()

    def clear_follow_up_queue(self) -> None:
        self._state.follow_up.clear()

    def clear_all_queues(self) -> None:
        self.clear_steering_queue()
        self.clear_follow_up_queue()

    @property
    def steering_mode(self) -> str:
        return self._state.steering_mode

    @steering_mode.setter
    def steering_mode(self, value: str) -> None:
        self._state.steering_mode = value

    @property
    def follow_up_mode(self) -> str:
        return self._state.follow_up_mode

    @follow_up_mode.setter
    def follow_up_mode(self, value: str) -> None:
        self._state.follow_up_mode = value

    # --------------------------------------------------------------- internals

    def _build_config(self) -> AgentLoopConfig:
        assert self._state.model is not None
        return AgentLoopConfig(
            model=self._state.model,
            convert_to_llm=self._convert_to_llm,
            tool_execution=self._tool_execution,
            before_tool_call=self._before_tool_call,
            after_tool_call=self._after_tool_call,
            transform_context=self._transform_context,
            should_stop_after_turn=self._should_stop_after_turn,
            thinking_budgets=self._thinking_budgets,
            thinking_level=self._state.thinking_level,
            max_turns=self._max_turns,
            session_id=self._session_id,
            stream_options=self._stream_options,
        )

    @staticmethod
    def _as_message(message: Message | str) -> Message:
        if isinstance(message, Message):
            return message
        return Message(role="user", content=message)

    def _coerce_prompts(self, content: Any) -> list[Message]:
        if isinstance(content, Message):
            return [content]
        if isinstance(content, str):
            return [Message(role="user", content=content)]
        if isinstance(content, list):
            prompts: list[Message] = []
            for item in content:
                if isinstance(item, Message):
                    prompts.append(item)
                elif isinstance(item, str):
                    prompts.append(Message(role="user", content=item))
                else:
                    prompts.append(Message(role="user", content=item))
            return prompts
        return [Message(role="user", content=content)]
