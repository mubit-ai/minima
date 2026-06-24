"""Hermetic tests for ai/compat.py (cross-provider thinking -> text)."""

from __future__ import annotations

from minima_harness.ai import AssistantMessage, Message, TextContent, ThinkingContent, ToolCall
from minima_harness.ai.compat import (
    normalize_for_target,
    source_api_of,
    thinking_to_text,
)


def test_thinking_to_text_folds_into_tagged_text():
    msg = AssistantMessage(
        model="claude-sonnet-4-6",
        content=[ThinkingContent(thinking="secret plan"), TextContent(text="answer")],
    )
    out = thinking_to_text(msg)
    assert all(not isinstance(b, ThinkingContent) for b in out.content)
    assert out.content[0].text == "<thinking>secret plan</thinking>"
    assert out.content[1].text == "answer"
    # original unchanged
    assert isinstance(msg.content[0], ThinkingContent)


def test_source_api_of_via_registry():
    assert (
        source_api_of(AssistantMessage(model="claude-haiku-4-5", content=[]))
        == "anthropic-messages"
    )
    assert (
        source_api_of(AssistantMessage(model="gemini-2.5-flash", content=[]))
        == "google-generative-ai"
    )
    assert source_api_of(AssistantMessage(model="", content=[])) is None
    assert source_api_of(AssistantMessage(model="never-heard-of-it", content=[])) is None


def test_normalize_for_target_converts_cross_provider_only():
    msgs = [
        AssistantMessage(
            model="claude-sonnet-4-6",  # anthropic source
            content=[ThinkingContent(thinking="h")],
        ),
        AssistantMessage(
            model="gemini-2.5-flash",  # google source
            content=[ThinkingContent(thinking="g")],
        ),
    ]
    to_google = normalize_for_target(msgs, "google-generative-ai")
    # anthropic assistant normalized; google assistant passed through
    assert any(isinstance(b, TextContent) for b in to_google[0].content)
    assert any(isinstance(b, ThinkingContent) for b in to_google[1].content)

    to_anth = normalize_for_target(msgs, "anthropic-messages")
    # anthropic assistant (same provider) passed through; google assistant normalized
    assert any(isinstance(b, ThinkingContent) for b in to_anth[0].content)
    assert any(isinstance(b, TextContent) for b in to_anth[1].content)


def test_normalize_leaves_non_assistant_and_tool_calls():
    msgs = [
        Message(role="user", content="hi"),
        AssistantMessage(
            model="claude-sonnet-4-6",
            content=[ToolCall(id="1", name="echo", arguments={}), TextContent(text="t")],
        ),
    ]
    out = normalize_for_target(msgs, "openai-completions")
    # tool call preserved on the (normalized) assistant message
    asst = out[1]
    assert any(isinstance(b, ToolCall) and b.name == "echo" for b in asst.content)
    # user message untouched
    assert out[0].text == "hi"
