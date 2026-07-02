"""Hermetic tests for ModelMapping (RankedModel -> harness Model)."""

from __future__ import annotations

import pytest

from minima.schemas.recommend import RankedModel
from minima_harness.ai import get_model
from minima_harness.ai.provider_catalog import PROVIDERS
from minima_harness.minima import ModelMapping


def _ranked(model_id: str, provider: str) -> RankedModel:
    return RankedModel(
        model_id=model_id,
        provider=provider,
        predicted_success=0.9,
        est_cost_usd=0.001,
        score=0.9,
    )


def test_exact_provider_id_resolution():
    m = ModelMapping().to_model(_ranked("claude-haiku-4-5", "anthropic"))
    assert m.id == "claude-haiku-4-5"
    assert m.api == "anthropic-messages"


def test_id_only_when_provider_string_differs():
    m = ModelMapping().to_model(_ranked("claude-haiku-4-5", "weird-provider"))
    assert m.id == "claude-haiku-4-5"


def test_openrouter_provider_model_split():
    m = ModelMapping().to_model(_ranked("google/gemini-2.5-flash", "openrouter"))
    assert m.id == "google/gemini-2.5-flash"
    assert m.api == "openai-completions"


def test_fallback_to_offline_default():
    default = get_model("openai", "gpt-4o-mini")
    m = ModelMapping().to_model(_ranked("totally-unknown", "weird"), offline_default=default)
    assert m is default


def test_no_match_no_default_raises():
    with pytest.raises(KeyError, match="no harness model"):
        ModelMapping().to_model(_ranked("totally-unknown", "weird"))


def test_default_model_is_cheapest(monkeypatch):
    for provider in PROVIDERS:
        for env_var in provider.env_vars:
            monkeypatch.delenv(env_var, raising=False)
    monkeypatch.delenv("OPENAI_COMPAT_API_KEY", raising=False)

    m = ModelMapping().default_model()
    # gpt-4o-mini: 0.15 + 0.60 = 0.75, the cheapest in the seed catalog
    assert m.id == "gpt-4o-mini"
