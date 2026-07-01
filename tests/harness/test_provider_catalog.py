"""Multi-provider catalog: provider-specific key resolution, key-gated registration,
base_url-aware offline fallback, and routing-candidate gating."""

from __future__ import annotations

import pytest

from minima_harness.ai.provider_catalog import (
    PROVIDERS,
    config_providers,
    env_vars_for_provider,
    provider_key_present,
    register_catalog_models,
    runnable_candidates,
)

_ALL_ENV = [v for p in PROVIDERS for v in p.env_vars]


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """Clear every provider key and snapshot/restore the global model registry, so these
    tests neither inherit the dev's shell keys nor pollute other test files."""
    for var in _ALL_ENV:
        monkeypatch.delenv(var, raising=False)
    from minima_harness.ai import registry

    snapshot = dict(registry._MODELS)
    yield
    registry._MODELS.clear()
    registry._MODELS.update(snapshot)


def test_env_vars_are_provider_specific():
    # An OpenAI model must resolve ONLY OPENAI_API_KEY — an OpenRouter key must never
    # green-light an api.openai.com call (the v0.4.1 mis-route bug the audit caught).
    assert env_vars_for_provider("openai") == ("OPENAI_API_KEY",)
    assert "OPENROUTER_API_KEY" not in env_vars_for_provider("openai")
    assert env_vars_for_provider("groq") == ("GROQ_API_KEY",)
    # Unknown/custom provider (e.g. a models.json entry) falls back to generic compat vars.
    assert "OPENAI_COMPAT_API_KEY" in env_vars_for_provider("some-custom-thing")


def test_provider_key_present_and_local(monkeypatch):
    assert not provider_key_present("openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    assert provider_key_present("openai")
    # Local runtimes (ollama, vllm, …) need no key.
    assert provider_key_present("ollama")


def test_register_only_for_configured_providers(monkeypatch):
    assert register_catalog_models() == []  # no keys -> register nothing
    monkeypatch.setenv("GROQ_API_KEY", "gk")
    assert "groq" in register_catalog_models()


def test_offline_default_is_key_and_base_url_aware(monkeypatch):
    # The audit scenario: with ONLY an OpenRouter key, the offline fallback must NOT pick
    # gpt-4o-mini (provider=openai, base_url=None -> hits api.openai.com).
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or")
    register_catalog_models()
    from minima_harness.minima.mapping import ModelMapping

    m = ModelMapping().default_model()
    assert m.provider == "openrouter"
    assert m.base_url and "openrouter.ai" in m.base_url
    assert m.id != "gpt-4o-mini"


def test_offline_default_prefers_runnable_provider(monkeypatch):
    # Only an Anthropic key -> fallback is an Anthropic model, not the globally cheapest openai.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    from minima_harness.minima.mapping import ModelMapping

    m = ModelMapping().default_model()
    assert m.provider == "anthropic"


def test_runnable_candidates_filters_by_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    out = runnable_candidates(["gemini-2.5-flash", "claude-haiku-4-5"])
    assert "gemini-2.5-flash" in out
    assert "claude-haiku-4-5" not in out  # no Anthropic key -> not runnable -> dropped
    # When NONE are runnable, return the original (so routing yields a clear auth error,
    # not an empty candidate set).
    assert runnable_candidates(["claude-haiku-4-5"]) == ["claude-haiku-4-5"]


def test_config_providers_curated_set():
    names = {p.name for p in config_providers()}
    # Popular open + closed providers surface in `minima config`.
    assert {"anthropic", "openai", "google", "openrouter", "groq", "deepseek"} <= names


def test_openai_compat_resolves_provider_specific_key(monkeypatch):
    from minima_harness.ai.providers._common import resolve_api_key

    monkeypatch.setenv("GROQ_API_KEY", "gk-123")
    # A Groq model resolves the Groq key; an OpenAI model has no key -> None (no mis-route).
    assert resolve_api_key(None, *env_vars_for_provider("groq")) == "gk-123"
    assert resolve_api_key(None, *env_vars_for_provider("openai")) is None
