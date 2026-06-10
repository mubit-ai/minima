"""Cross-provider outcome signal normalization.

Different LLM providers report success, failure, and token usage in
incompatible shapes (OpenAI, Anthropic, Gemini / Google GenAI, LiteLLM). This
module maps any of them to a single normalized outcome the control plane
understands::

    {"outcome", "signal", "success", "latency_ms", "tokens", "provider"}

It is intentionally dependency-free and duck-typed so it works with provider
response objects or plain dicts, and degrades gracefully on unknown shapes —
feeding the same clean signal into ``record_outcome`` regardless of provider.
"""

from __future__ import annotations

from typing import Any, Optional

__all__ = ["normalize_outcome", "extract_tokens"]


def _get(obj: Any, *names: str) -> Any:
    """Fetch the first present attribute/key among ``names`` from ``obj``."""
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
        elif hasattr(obj, name):
            return getattr(obj, name)
    return None


def extract_tokens(response: Any) -> Optional[int]:
    """Best-effort total token count across provider response shapes."""
    if response is None:
        return None
    usage = _get(response, "usage", "usage_metadata")
    if usage is None:
        return None
    # OpenAI / LiteLLM: total_tokens. Gemini: total_token_count.
    total = _get(usage, "total_tokens", "total_token_count")
    if isinstance(total, (int, float)):
        return int(total)
    # Anthropic: input_tokens + output_tokens. Gemini split fields also handled.
    prompt = _get(usage, "input_tokens", "prompt_tokens", "prompt_token_count")
    completion = _get(
        usage, "output_tokens", "completion_tokens", "candidates_token_count"
    )
    parts = [int(x) for x in (prompt, completion) if isinstance(x, (int, float))]
    return sum(parts) if parts else None


def normalize_outcome(
    *,
    provider: str = "",
    response: Any = None,
    error: Optional[BaseException] = None,
    latency_ms: Optional[float] = None,
    default_success_signal: float = 0.5,
    default_failure_signal: float = -0.7,
) -> dict:
    """Normalize a provider call result into a control-plane outcome dict.

    Failure is inferred from a raised ``error`` or a populated ``error`` field
    on ``response`` (some SDKs return rather than raise). Everything else is a
    success. Signals default to a mild reward / penalty and are clamped to
    ``[-1, 1]``; callers may override the defaults per call site.
    """
    failed = error is not None
    if not failed and response is not None and _get(response, "error"):
        failed = True

    if failed:
        outcome, signal = "failure", default_failure_signal
    else:
        outcome, signal = "success", default_success_signal

    return {
        "outcome": outcome,
        "signal": float(max(-1.0, min(1.0, signal))),
        "success": not failed,
        "latency_ms": float(latency_ms) if latency_ms is not None else None,
        "tokens": extract_tokens(response),
        "provider": provider or None,
    }
