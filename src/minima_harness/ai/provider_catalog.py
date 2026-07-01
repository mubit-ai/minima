"""Static provider catalog metadata used by tests and convenience helpers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProviderCatalogEntry:
    name: str
    api_id: str
    env_vars: tuple[str, ...]


PROVIDERS: tuple[ProviderCatalogEntry, ...] = (
    ProviderCatalogEntry(
        name="openai",
        api_id="openai-completions",
        env_vars=("OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENROUTER_API_KEY"),
    ),
    ProviderCatalogEntry(
        name="anthropic",
        api_id="anthropic-messages",
        env_vars=("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"),
    ),
    ProviderCatalogEntry(
        name="google",
        api_id="google-generative-ai",
        env_vars=("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"),
    ),
    ProviderCatalogEntry(
        name="openrouter",
        api_id="openai-completions",
        env_vars=("OPENROUTER_API_KEY",),
    ),
)

