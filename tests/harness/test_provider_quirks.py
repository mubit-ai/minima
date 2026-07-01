"""Per-provider request quirks table."""

from __future__ import annotations

from minima_harness.ai.provider_quirks import quirks_for


def test_openai_uses_max_completion_tokens():
    assert quirks_for("openai").token_param == "max_completion_tokens"


def test_other_providers_use_max_tokens():
    for provider in ("groq", "openrouter", "deepseek", "together", "anthropic", "unknown-host"):
        assert quirks_for(provider).token_param == "max_tokens"
