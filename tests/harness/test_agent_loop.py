"""Hermetic tests for the ported agent runtime (pi-agent-core) via the faux provider.

Covers: event sequence, single + multi tool-call flows, parallel vs sequential
execution timing, beforeToolCall block, afterToolCall terminate hint, arg-validation
error path, steering/follow-up queues, subscribe (sync + async), abort, max_turns.
"""

from __future__ import annotations

import asyncio
import time

from pydantic import BaseModel

from minima_harness.agent import (
    Agent,
    AgentTool,
    BeforeToolCallContext,
    BeforeToolCallResult,
    ToolResult,
)
from minima_harness.ai import AssistantMessage, TextContent, ToolCall
from minima_harness.ai.providers import register_faux_provider


class EchoParams(BaseModel):
    text: str


class Empty(BaseModel):
    pass


async def _echo(tool_call_id, params, signal, on_update):
    return ToolResult(
        content=[TextContent(text=f"echo: {params.text}")], details={"id": tool_call_id}
    )


def _echo_tool():
    return AgentTool(name="echo", description="echo back", parameters=EchoParams, execute=_echo)


def _text_msg(text: str, stop: str = "stop") -> AssistantMessage:
    return AssistantMessage(content=[TextContent(text=text)], stop_reason=stop)  # type: ignore[arg-type]


def _tool_msg(calls: list[ToolCall]) -> AssistantMessage:
    return AssistantMessage(content=calls, stop_reason="toolUse")  # type: ignore[arg-type]


# --------------------------------------------------------------------------- basics


def test_basic_text_prompt_event_sequence():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("hello")])
        agent = Agent(model=reg.get_model(), system_prompt="be brief")
        seen = []
        agent.subscribe(lambda e: seen.append(e.type))
        asyncio.run(agent.prompt("hi"))
        types = seen
        assert types[0] == "agent_start"
        assert types[-1] == "agent_end"
        assert types.count("turn_start") == 1
        assert types.count("turn_end") == 1
        # prompt user msg + assistant msg each get a start/end
        assert types.count("message_start") == 2
        assert types.count("message_end") == 2
        assert "message_update" in types
        assert agent.state.messages[-1].text == "hello"
        assert agent.state.error_message is None


def test_single_tool_call_then_continue():
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg([ToolCall(id="t1", name="echo", arguments={"text": "hi"})]),
                _text_msg("done"),
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[_echo_tool()])
        asyncio.run(agent.prompt("call echo"))
        msgs = agent.state.messages
        # user, assistant(toolUse), toolResult, assistant(stop)
        assert [m.role for m in msgs] == ["user", "assistant", "toolResult", "assistant"]
        assert msgs[2].text == "echo: hi"
        assert msgs[2].is_error is False
        assert msgs[3].text == "done"
        assert reg.state.call_count == 2


# ----------------------------------------------------------------------- tools


def test_parallel_tool_calls_overlap_in_time():
    ran_at: list[tuple[str, float]] = []

    async def slow(tool_call_id, params, signal, on_update):
        name = tool_call_id
        ran_at.append((name, time.monotonic()))
        await asyncio.sleep(0.05)
        return ToolResult(content=[TextContent(text=name)])

    tool = AgentTool(name="slow", description="d", parameters=Empty, execute=slow)
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg(
                    [
                        ToolCall(id="a", name="slow", arguments={}),
                        ToolCall(id="b", name="slow", arguments={}),
                    ]
                ),
                _text_msg("ok"),
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[tool], tool_execution="parallel")
        start = time.monotonic()
        asyncio.run(agent.prompt("go"))
        elapsed = time.monotonic() - start
    # Parallel: both start near-simultaneously -> total ~ one sleep, not two.
    assert elapsed < 0.09, f"expected parallel (<90ms), got {elapsed:.3f}s"
    assert len(ran_at) == 2


def test_sequential_tool_calls_run_one_at_a_time():
    async def slow(tool_call_id, params, signal, on_update):
        await asyncio.sleep(0.05)
        return ToolResult(content=[TextContent(text=tool_call_id)])

    tool = AgentTool(name="slow", description="d", parameters=Empty, execute=slow)
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg(
                    [
                        ToolCall(id="a", name="slow", arguments={}),
                        ToolCall(id="b", name="slow", arguments={}),
                    ]
                ),
                _text_msg("ok"),
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[tool], tool_execution="sequential")
        start = time.monotonic()
        asyncio.run(agent.prompt("go"))
        elapsed = time.monotonic() - start
    assert elapsed >= 0.09, f"expected sequential (>=90ms), got {elapsed:.3f}s"


def test_before_tool_call_blocks():
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg([ToolCall(id="t1", name="echo", arguments={"text": "x"})]),
                _text_msg("recovered"),
            ]
        )

        async def block_echo(ctx: BeforeToolCallContext) -> BeforeToolCallResult:
            return BeforeToolCallResult(block=True, reason="echo disabled")

        agent = Agent(
            model=reg.get_model(),
            tools=[_echo_tool()],
            before_tool_call=block_echo,
        )
        asyncio.run(agent.prompt("call echo"))
        tr = agent.state.messages[2]
        assert tr.role == "toolResult"
        assert tr.is_error is True
        assert "echo disabled" in tr.text


def test_after_tool_call_terminate_skips_followup():
    async def terminating(tool_call_id, params, signal, on_update):
        return ToolResult(content=[TextContent(text="done")], terminate=True)

    tool = AgentTool(name="once", description="d", parameters=Empty, execute=terminating)
    with register_faux_provider() as reg:
        # Only the toolUse response is queued; terminate must stop before a 2nd call.
        reg.set_responses([_tool_msg([ToolCall(id="t1", name="once", arguments={})])])
        agent = Agent(model=reg.get_model(), tools=[tool])
        asyncio.run(agent.prompt("go"))
        assert reg.state.call_count == 1
        roles = [m.role for m in agent.state.messages]
        assert roles == ["user", "assistant", "toolResult"]


def test_invalid_tool_args_become_tool_error():
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg([ToolCall(id="t1", name="echo", arguments={})]),  # missing text
                _text_msg("retry-ok"),
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[_echo_tool()])
        asyncio.run(agent.prompt("call echo badly"))
        tr = agent.state.messages[2]
        assert tr.is_error is True
        assert "text" in tr.text  # validation message names the field


def test_unknown_tool_becomes_tool_error():
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                _tool_msg([ToolCall(id="t1", name="nope", arguments={})]),
                _text_msg("ok"),
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[_echo_tool()])
        asyncio.run(agent.prompt("go"))
        assert "Unknown tool" in agent.state.messages[2].text


# --------------------------------------------------------------- steering/abort


def test_follow_up_queue_runs_another_turn():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("first"), _text_msg("second")])
        agent = Agent(model=reg.get_model())
        agent.follow_up("and then?")
        asyncio.run(agent.prompt("hi"))
        assert reg.state.call_count == 2
        texts = [m.text for m in agent.state.messages if m.role == "assistant"]
        assert texts == ["first", "second"]


def test_steering_injected_between_turns():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("first"), _text_msg("steered")])
        agent = Agent(model=reg.get_model())

        async def steer_after_first(event):
            if getattr(event, "type", "") == "turn_end" and reg.state.call_count == 1:
                agent.steer("do something else")

        agent.subscribe(steer_after_first)
        asyncio.run(agent.prompt("hi"))
        assert reg.state.call_count == 2


def test_abort_stops_run_and_marks_error():
    started = asyncio.Event()

    async def gating(tool_call_id, params, signal, on_update):
        started.set()
        await asyncio.sleep(10)
        return ToolResult(content=[TextContent(text="never")])

    tool = AgentTool(name="gate", description="d", parameters=Empty, execute=gating)
    with register_faux_provider() as reg:
        reg.set_responses([_tool_msg([ToolCall(id="t1", name="gate", arguments={})])])
        agent = Agent(model=reg.get_model(), tools=[tool])

        async def driver():
            task = asyncio.create_task(agent.prompt("go"))
            await started.wait()
            agent.abort()
            await task

        asyncio.run(driver())
        assert agent.state.is_streaming is False
        assert agent.state.error_message == "aborted"


def test_max_turns_guard_prevents_infinite_loop():
    with register_faux_provider() as reg:
        # Always request a tool; tool always returns non-terminating.
        reg.set_responses([_tool_msg([ToolCall(id="t0", name="echo", arguments={"text": "x"})])])
        reg.append_responses(
            [
                _tool_msg([ToolCall(id=f"t{n}", name="echo", arguments={"text": "x"})])
                for n in range(60)
            ]
        )
        agent = Agent(model=reg.get_model(), tools=[_echo_tool()], max_turns=3)
        asyncio.run(agent.prompt("loop"))
        # stopped by max_turns, not by exhausting responses
        assert reg.state.call_count == 3


def test_async_listener_is_awaited_in_order():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("hi")])
        agent = Agent(model=reg.get_model())
        order: list[str] = []

        async def slow_listener(event):
            order.append(event.type)

        agent.subscribe(slow_listener)
        asyncio.run(agent.prompt("x"))
        assert order[0] == "agent_start"
        assert order[-1] == "agent_end"
