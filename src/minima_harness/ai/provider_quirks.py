"""Per-provider request quirks for the OpenAI-compatible provider, as DATA not control flow.

Most OpenAI-compatible hosts speak the identical wire protocol, but a few diverge on small
request details — e.g. OpenAI's GPT-5 / o-series reject ``max_tokens`` and require
``max_completion_tokens``. Encoding those as a lookup table (rather than a growing chain of
``if model.provider == ...`` branches in :mod:`~minima_harness.ai.providers.openai_compat`)
keeps the single hand-rolled provider lean and makes the next quirk a one-line data entry.

This is the Python-appropriate analogue of OpenCode's per-provider "compatibility lowering":
a small table, not a class hierarchy. It is the single place provider param drift is encoded.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProviderQuirks:
    """How one provider's chat-completions request differs from the OpenAI baseline."""

    # Name of the max-output-tokens param. OpenAI's GPT-5/o-series need max_completion_tokens;
    # every other OpenAI-compatible host (groq, openrouter, deepseek, …) uses the classic name.
    token_param: str = "max_tokens"


_DEFAULT = ProviderQuirks()

# Keyed by harness provider id. Only providers that DIVERGE from the baseline appear here.
_QUIRKS: dict[str, ProviderQuirks] = {
    "openai": ProviderQuirks(token_param="max_completion_tokens"),
}


def quirks_for(provider: str) -> ProviderQuirks:
    """Quirks for ``provider`` (the baseline OpenAI-compatible behavior if it has none)."""
    return _QUIRKS.get(provider, _DEFAULT)
