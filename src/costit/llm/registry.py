"""Build a reasoner from settings, or None when disabled/unconfigured."""

from __future__ import annotations

from costit.config import Settings
from costit.llm.base import Reasoner
from costit.logging import get_logger

log = get_logger("costit.llm")


def build_reasoner(settings: Settings) -> Reasoner | None:
    provider = settings.costit_reasoner_provider.lower().strip()
    if provider in ("", "none"):
        return None

    if provider == "anthropic":
        if not settings.anthropic_api_key:
            log.warning("reasoner_disabled_no_key", provider="anthropic")
            return None
        # The provider SDK is imported lazily (here and inside the constructor), so
        # catch ImportError across both: a missing extra must degrade, not crash startup.
        try:
            from costit.llm.anthropic import DEFAULT_MODEL, AnthropicReasoner

            return AnthropicReasoner(
                model=settings.costit_reasoner_model or DEFAULT_MODEL,
                api_key=settings.anthropic_api_key,
                timeout_ms=settings.costit_reasoner_timeout_ms,
                max_tokens=settings.costit_reasoner_max_tokens,
            )
        except ImportError:
            log.warning("reasoner_extra_missing", provider="anthropic", extra="reasoner-anthropic")
            return None

    if provider == "gemini":
        if not settings.gemini_api_key:
            log.warning("reasoner_disabled_no_key", provider="gemini")
            return None
        try:
            from costit.llm.gemini import DEFAULT_MODEL, GeminiReasoner

            return GeminiReasoner(
                model=settings.costit_reasoner_model or DEFAULT_MODEL,
                api_key=settings.gemini_api_key,
                timeout_ms=settings.costit_reasoner_timeout_ms,
                max_tokens=settings.costit_reasoner_max_tokens,
            )
        except ImportError:
            log.warning("reasoner_extra_missing", provider="gemini", extra="reasoner-gemini")
            return None

    log.warning("reasoner_unknown_provider", provider=provider)
    return None
