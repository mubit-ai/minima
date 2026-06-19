"""Hermetic smoke tests for minima_harness Phase 0 (no real LLM calls)."""

from __future__ import annotations

import pytest
from pydantic import BaseModel as Params

from minima_harness import ai
from minima_harness.ai import (
    AssistantMessage,
    Context,
    Message,
    TextContent,
    ThinkingContent,
    ToolCall,
)
from minima_harness.ai.providers import register_faux_provider
from minima_harness.minima import HarnessConfig
from minima_harness.tasks import TASKS, Task, grade_outcome


def test_registry_seed_and_lookup():
    providers = ai.get_providers()
    assert {"anthropic", "google", "openai", "openrouter"} <= set(providers)

    m = ai.get_model("anthropic", "claude-haiku-4-5")
    assert m.api == "anthropic-messages"
    assert m.cost.input == 1.0
    assert m.context_window == 200_000

    with pytest.raises(KeyError):
        ai.get_model("anthropic", "nope")


def test_message_content_string_coercion_and_text():
    msg = Message(role="user", content="hello")
    assert isinstance(msg.content, list)
    assert msg.text == "hello"
    assert msg.content[0].type == "text"


def test_assistant_message_tool_calls():
    msg = AssistantMessage(
        content=[
            TextContent(text="ok"),
            ToolCall(id="t1", name="echo", arguments={"x": 1}),
        ],
    )
    assert len(msg.tool_calls) == 1
    assert msg.tool_calls[0].name == "echo"


def test_usage_cost_attachment():
    from minima_harness.ai.types import Usage

    m = ai.get_model("openai", "gpt-4o")  # 2.5 / 10 per MTok
    usage = Usage(input=1_000_000, output=500_000)
    cost = ai.cost_for(m, usage)
    assert cost.input == pytest.approx(2.5)
    assert cost.output == pytest.approx(5.0)
    assert cost.total == pytest.approx(7.5)


def test_validate_tool_call_happy_and_error():
    class EchoParams(Params):
        text: str

    tools = [ai.Tool(name="echo", description="d", parameters=EchoParams)]
    call_ok = ToolCall(id="1", name="echo", arguments={"text": "hi"})
    parsed = ai.validate_tool_call(tools, call_ok)
    assert parsed.model_dump()["text"] == "hi"

    call_bad = ToolCall(id="2", name="echo", arguments={})
    with pytest.raises(ai.ToolParamError):
        ai.validate_tool_call(tools, call_bad)

    with pytest.raises(ai.UnknownToolError):
        ai.validate_tool_call(tools, ToolCall(id="3", name="missing", arguments={}))


def test_faux_provider_stream_and_complete():
    with register_faux_provider() as reg:
        model = reg.get_model()
        reg.set_responses(
            [
                AssistantMessage(
                    content=[
                        ThinkingContent(thinking="hmm"),
                        TextContent(text="hello world"),
                    ],
                    stop_reason="stop",
                )
            ]
        )

        events = []
        s = ai.stream(model, Context(messages=[Message(role="user", content="hi")]))

        async def drain() -> None:
            async for ev in s:
                events.append(ev.type)

        import asyncio

        asyncio.run(drain())
        assert events[0] == "start"
        assert events[-1] == "done"
        assert "thinking_delta" in events
        assert "text_delta" in events
        assert reg.state.call_count == 1
        assert reg.state.pending_response_count == 0

        # complete() path
        reg.set_responses([AssistantMessage(content=[TextContent(text="again")])])
        msg = asyncio.run(
            ai.complete(model, Context(messages=[Message(role="user", content="hi")]))
        )
        assert msg.text == "again"
        assert msg.usage.output >= 1  # estimated from chars
        assert msg.usage.cost.total >= 0.0


def test_faux_provider_empty_queue_errors():
    with register_faux_provider() as reg:
        model = reg.get_model()
        import asyncio

        msg = asyncio.run(
            ai.complete(model, Context(messages=[Message(role="user", content="hi")]))
        )
        assert msg.stop_reason == "error"
        assert msg.error_message == "No more faux responses queued"


def test_faux_provider_unregisters():
    from minima_harness.ai.providers import registered_apis

    assert "faux" not in registered_apis()
    with register_faux_provider():
        assert "faux" in registered_apis()
    assert "faux" not in registered_apis()


def test_harness_config_from_env(monkeypatch):
    monkeypatch.setenv("MINIMA_URL", "https://api.minima.sh")
    monkeypatch.setenv("MINIMA_API_KEY", "mbt_x")
    cfg = HarnessConfig.from_env()
    assert cfg.minima_url == "https://api.minima.sh"
    assert cfg.minima_api_key == "mbt_x"
    assert cfg.cost_quality_tradeoff == 5.0


def test_tasks_and_grade_outcome():
    assert len(TASKS) >= 3
    t = TASKS[0]
    assert isinstance(t, Task)
    assert t.quality_fn is not None
    assert grade_outcome(0.9) == "success"
    assert grade_outcome(0.5) == "partial"
    assert grade_outcome(0.1) == "failure"
    with pytest.raises(AssertionError):
        Task(label="x", prompt="p", task_type="qa", slider=11.0)
