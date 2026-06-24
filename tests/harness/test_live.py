"""Live provider smoke tests (skip without keys; selected by available env var).

Run with: ``uv run pytest tests/harness -m live``
Requires real provider API keys and spends a few cents.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from minima_harness.ai import Context, Message, complete

pytestmark = pytest.mark.live


def _env(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


async def _smoke(model_id: str, provider: str) -> None:
    from minima_harness.ai import get_model

    model = get_model(provider, model_id)
    msg = await complete(
        model, Context(messages=[Message(role="user", content="Reply with the single word: pong")])
    )
    assert msg.stop_reason != "error", getattr(msg, "error_message", "")
    assert "pong" in msg.text.lower()
    assert msg.usage.cost.total >= 0.0


@pytest.mark.skipif(
    not _env("OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY"), reason="needs OPENAI_API_KEY"
)
def test_live_openai() -> None:
    asyncio.run(_smoke("gpt-4o-mini", "openai"))


@pytest.mark.skipif(not _env("OPENROUTER_API_KEY"), reason="needs OPENROUTER_API_KEY")
def test_live_openrouter() -> None:
    asyncio.run(_smoke("google/gemini-2.5-flash", "openrouter"))


@pytest.mark.skipif(not _env("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")
def test_live_anthropic() -> None:
    asyncio.run(_smoke("claude-haiku-4-5", "anthropic"))


@pytest.mark.skipif(not _env("GEMINI_API_KEY", "GOOGLE_API_KEY"), reason="needs GEMINI_API_KEY")
def test_live_google() -> None:
    asyncio.run(_smoke("gemini-2.5-flash", "google"))
