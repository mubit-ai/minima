"""Hermetic tests for provider helpers (JSON schema cleanup, openai wire shape)."""

from __future__ import annotations

from pydantic import BaseModel

from minima_harness.ai import Context, Message, TextContent, Tool, ToolCall
from minima_harness.ai.providers._common import to_json_schema
from minima_harness.ai.providers.openai_compat import _build_payload, _to_wire


class EchoParams(BaseModel):
    location: str
    units: str = "celsius"


def test_to_json_schema_strips_title_and_flattens_literal():
    from typing import Literal

    class P(BaseModel):
        level: Literal["low", "med", "high"]

    schema = to_json_schema(P)
    assert "title" not in schema
    assert schema["properties"]["level"]["enum"] == ["low", "med", "high"]
    assert "anyOf" not in schema["properties"]["level"]


def test_openai_to_wire_user_assistant_and_tool_result():
    user = _to_wire(Message(role="user", content="hello"))
    assert user == {"role": "user", "content": "hello"}

    asst = _to_wire(
        Message(
            role="assistant",
            content=[
                TextContent(text="calling"),
                ToolCall(id="t1", name="echo", arguments={"location": "x"}),
            ],
        )
    )
    assert asst["role"] == "assistant"
    assert asst["content"] == "calling"
    assert asst["tool_calls"][0]["function"]["name"] == "echo"
    assert '"location"' in asst["tool_calls"][0]["function"]["arguments"]

    tool_res = _to_wire(
        Message(role="toolResult", tool_call_id="t1", tool_name="echo", content="ok")
    )
    assert tool_res == {"role": "tool", "tool_call_id": "t1", "content": "ok"}


def test_build_payload_includes_tools_and_stream_options():
    model = type(  # noqa: N999 - throwaway model for payload shape only
        "M",
        (),
        {
            "id": "gpt-4o-mini",
            "provider": "openai",
            "api": "openai-completions",
            "base_url": None,
            "headers": {},
            "max_tokens": 1024,
        },
    )()
    payload = _build_payload(
        model,  # type: ignore[arg-type]
        Context(
            system_prompt="be brief",
            messages=[Message(role="user", content="hi")],
            tools=[Tool(name="echo", description="d", parameters=EchoParams)],
        ),
        {},
    )
    assert payload["model"] == "gpt-4o-mini"
    assert payload["messages"][0] == {"role": "system", "content": "be brief"}
    assert payload["stream"] is True
    assert payload["stream_options"] == {"include_usage": True}
    assert payload["tools"][0]["function"]["name"] == "echo"
    assert (
        payload["tools"][0]["function"]["parameters"]["properties"]["location"]["type"] == "string"
    )
