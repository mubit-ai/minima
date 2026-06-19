"""The agent loop — a port of PI's ``agentLoop`` async generator.

Runs turn after turn: stream the model -> emit message events -> if it requested tools,
execute them (parallel via anyio, with before/afterToolCall hooks) -> append tool
results -> continue. Steering/follow-up queues are drained between turns. Emits the full
PI event taxonomy so any subscriber can render the run.

Tool-execution events are replayed in completion order (the loop awaits the whole batch,
then yields the buffered events); final ``toolResult`` messages are appended in assistant
source order. This is correct and deterministic for the harness's needs.
"""

from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator
from typing import Any

import anyio
from pydantic import ValidationError

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
from minima_harness.agent.state import AgentLoopConfig, AgentState
from minima_harness.agent.tools import (
    AfterToolCallContext,
    BeforeToolCallContext,
    ToolResult,
    error_result,
    find_agent_tool,
)
from minima_harness.ai.stream import stream as default_stream
from minima_harness.ai.types import Context, Message, Tool

_PendingTool = tuple[Any, Any, Any]  # (tool_call, AgentTool, validated_params)


async def agent_loop(
    prompts: list[Message],
    state: AgentState,
    config: AgentLoopConfig,
) -> AsyncIterator[Any]:
    """Run the agent over ``prompts`` appended to ``state``, yielding AgentEvents."""
    if state.model is None:
        raise ValueError("AgentState.model must be set before running the loop")

    yield AgentStartEvent()

    for prompt in prompts:
        state.messages.append(prompt)
        yield MessageStartEvent(message=prompt)
        yield MessageEndEvent(message=prompt)

    stream_fn = config.stream_fn or default_stream
    turns = 0
    while turns < config.max_turns:
        turns += 1
        yield TurnStartEvent()

        llm_messages = await _prepare_messages(state, config)
        ctx = Context(
            system_prompt=state.system_prompt,
            messages=llm_messages,
            tools=[
                Tool(name=t.name, description=t.description, parameters=t.parameters)
                for t in state.tools
            ],
        )
        options = _stream_options(config)
        s = stream_fn(state.model, ctx, options=options)
        yield MessageStartEvent(message=None)
        async for stream_event in s:
            yield MessageUpdateEvent(assistant_message_event=stream_event)
        assistant = await s.result()
        state.streaming_message = assistant
        state.messages.append(assistant)
        yield MessageEndEvent(message=assistant)

        if assistant.stop_reason == "error":
            state.error_message = assistant.error_message or "provider error"
            yield TurnEndEvent(message=assistant, tool_results=[])
            break

        tool_calls = assistant.tool_calls if assistant.stop_reason == "toolUse" else []
        results: list[tuple[Any, ToolResult, bool]] = []
        if tool_calls:
            async for ev in _execute_tool_calls(tool_calls, config, state, results):
                yield ev
            for tc, result, is_error in results:
                tr = Message(
                    role="toolResult",
                    tool_call_id=tc.id,
                    tool_name=tc.name,
                    content=result.content,
                    is_error=is_error,
                )
                state.messages.append(tr)
                yield MessageStartEvent(message=tr)
                yield MessageEndEvent(message=tr)

        yield TurnEndEvent(message=assistant, tool_results=[r for _, r, _ in results])

        if results and all(r.terminate for _, r, _ in results):
            break
        if config.should_stop_after_turn is not None and await config.should_stop_after_turn(
            assistant, [r for _, r, _ in results], state, state.messages
        ):
            break

        injected = _pop_queue(state.steering, state.steering_mode)
        if injected:
            for m in injected:
                state.messages.append(m)
                yield MessageStartEvent(message=m)
                yield MessageEndEvent(message=m)
            continue

        if not tool_calls:
            injected = _pop_queue(state.follow_up, state.follow_up_mode)
            if injected:
                for m in injected:
                    state.messages.append(m)
                    yield MessageStartEvent(message=m)
                    yield MessageEndEvent(message=m)
                continue
            break

    state.streaming_message = None
    yield AgentEndEvent(messages=list(state.messages))


async def agent_loop_continue(state: AgentState, config: AgentLoopConfig) -> AsyncIterator[Any]:
    """Resume from existing context (last message must be user or toolResult)."""
    if state.messages:
        last = state.messages[-1]
        if last.role == "assistant":
            raise ValueError(
                "agent_loop_continue requires the last message to be user or toolResult"
            )
    # Trick: agent_loop is an async generator; forward its yields.
    async for ev in agent_loop([], state, config):  # pragma: no cover - delegated
        yield ev


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _prepare_messages(state: AgentState, config: AgentLoopConfig) -> list[Message]:
    messages = state.messages
    if config.transform_context is not None:
        messages = await config.transform_context(messages, None)
    return config.convert_to_llm(messages)


def _stream_options(config: AgentLoopConfig) -> dict[str, Any]:
    opts: dict[str, Any] = dict(config.stream_options or {})
    opts["thinking"] = config.thinking_level != "off"
    if config.thinking_level != "off":
        budget = (config.thinking_budgets or {}).get(config.thinking_level)
        if budget is not None:
            opts["thinking_budget"] = budget
    if config.session_id:
        opts["session_id"] = config.session_id
    return opts


async def _execute_tool_calls(
    tool_calls: list[Any],
    config: AgentLoopConfig,
    state: AgentState,
    out_results: list[tuple[Any, ToolResult, bool]],
) -> AsyncIterator[Any]:
    """Preflight (yield tool_execution_start) then execute; yield updates + ends.

    Appends results to ``out_results`` in assistant SOURCE order; buffered events are
    replayed in completion order.
    """
    plan: list[_PendingTool] = []
    for tc in tool_calls:
        state.pending_tool_calls.add(tc.id)
        tool = find_agent_tool(state.tools, tc.name)
        if tool is None:
            yield ToolExecutionStartEvent(tool_call_id=tc.id, tool_name=tc.name, args=None)
            res = error_result(f"Unknown tool: {tc.name}")
            yield ToolExecutionEndEvent(tool_call_id=tc.id, result=res, is_error=True)
            out_results.append((tc, res, True))
            state.pending_tool_calls.discard(tc.id)
            continue
        try:
            params = tool.parameters.model_validate(tc.arguments)
        except ValidationError as exc:
            yield ToolExecutionStartEvent(tool_call_id=tc.id, tool_name=tc.name, args=None)
            res = error_result(_format_validation_error(exc))
            yield ToolExecutionEndEvent(tool_call_id=tc.id, result=res, is_error=True)
            out_results.append((tc, res, True))
            state.pending_tool_calls.discard(tc.id)
            continue
        yield ToolExecutionStartEvent(tool_call_id=tc.id, tool_name=tc.name, args=params)
        if config.before_tool_call is not None:
            decision = await config.before_tool_call(
                BeforeToolCallContext(tool_call=tc, args=params, context=state)
            )
            if decision is not None and decision.block:
                res = error_result(decision.reason or "blocked by beforeToolCall")
                yield ToolExecutionEndEvent(tool_call_id=tc.id, result=res, is_error=True)
                out_results.append((tc, res, True))
                state.pending_tool_calls.discard(tc.id)
                continue
        plan.append((tc, tool, params))

    sequential = config.tool_execution == "sequential" or any(
        t.execution_mode == "sequential" for _, t, _ in plan
    )
    completion: list[tuple[Any, list, ToolResult, bool]] = []
    if sequential:
        for tc, tool, params in plan:
            completion.append(await _run_one(tc, tool, params, config, state))
    else:
        async with anyio.create_task_group() as tg:

            async def runner(tc: Any, tool: Any, params: Any) -> None:
                completion.append(await _run_one(tc, tool, params, config, state))

            for tc, tool, params in plan:
                tg.start_soon(runner, tc, tool, params)

    by_id: dict[str, tuple[Any, ToolResult, bool]] = {}
    for tc, updates, result, is_error in completion:
        for upd in updates:
            yield upd
        yield ToolExecutionEndEvent(tool_call_id=tc.id, result=result, is_error=is_error)
        state.pending_tool_calls.discard(tc.id)
        by_id[tc.id] = (tc, result, is_error)

    for tc, _, _ in plan:  # source order
        out_results.append(by_id[tc.id])


async def _run_one(
    tc: Any, tool: Any, params: Any, config: AgentLoopConfig, state: AgentState
) -> tuple[Any, list, ToolResult, bool]:
    updates: list[Any] = []

    def on_update(partial: Any) -> None:
        updates.append(ToolExecutionUpdateEvent(tool_call_id=tc.id, partial=partial))

    try:
        result = await tool.execute(tc.id, params, None, on_update)
        is_error = False
    except Exception as exc:  # noqa: BLE001 - surface as tool error, not a raise
        result = error_result(str(exc))
        is_error = True

    if config.after_tool_call is not None:
        ar = await config.after_tool_call(
            AfterToolCallContext(tool_call=tc, result=result, is_error=is_error, context=state)
        )
        if ar is not None:
            if ar.terminate:
                result.terminate = True
            if ar.details is not None:
                result.details = {**result.details, **ar.details}
            if ar.content is not None:
                result.content = ar.content

    return tc, updates, result, is_error


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err["loc"]) or "<root>"
        parts.append(f"{loc}: {err['msg']}")
    return "; ".join(parts)


def _pop_queue(queue: deque[Message], mode: str) -> list[Message]:
    """Pop messages per mode: one for ``one-at-a-time``, all for ``all``."""
    if not queue:
        return []
    if mode == "one-at-a-time":
        return [queue.popleft()]
    drained = list(queue)
    queue.clear()
    return drained
