"""Provider registry entry point.

Real providers self-register on import. Their modules are imported defensively so a
missing optional SDK only skips that provider (logged at debug) rather than breaking
``import minima_harness``. The faux provider registers on demand via
:func:`register_faux_provider`.

Always available:
  - openai-completions  (raw httpx; httpx is a core dep)
Conditionally (need the ``harness`` extra: ``anthropic`` + ``google-genai``):
  - anthropic-messages
  - google-generative-ai
"""

from __future__ import annotations

import logging

from minima_harness.ai.providers.base import (
    Provider,
    get_provider,
    register_provider,
    registered_apis,
    unregister_provider,
)
from minima_harness.ai.providers.faux import register_faux_provider

_log = logging.getLogger("minima_harness.ai.providers")

_REGISTERED = False


def ensure_providers_registered() -> None:
    """Idempotently import the real provider modules so they self-register.

    Called lazily from :func:`minima_harness.ai.stream` to keep ``import minima_harness``
    side-effect-free.
    """
    global _REGISTERED
    if _REGISTERED:
        return
    _REGISTERED = True

    try:
        from minima_harness.ai.providers import openai_compat  # noqa: F401

        register_provider(
            openai_compat.OpenAICompatProvider.api_id, openai_compat.OpenAICompatProvider()
        )
    except Exception as exc:  # noqa: BLE001 - httpx should always be present
        _log.debug("openai-completions provider not registered: %s", exc)

    for mod, api, cls in (
        ("anthropic", "anthropic-messages", "AnthropicProvider"),
        ("google", "google-generative-ai", "GoogleProvider"),
    ):
        try:
            imported = __import__(f"minima_harness.ai.providers.{mod}", fromlist=[cls])
            provider_cls = getattr(imported, cls)
            register_provider(api, provider_cls())
        except ImportError as exc:
            _log.debug("%s provider skipped (SDK not installed): %s", api, exc)
        except Exception as exc:  # noqa: BLE001
            _log.warning("%s provider failed to register: %s", api, exc)


__all__ = [
    "Provider",
    "ensure_providers_registered",
    "get_provider",
    "register_faux_provider",
    "register_provider",
    "registered_apis",
    "unregister_provider",
]
