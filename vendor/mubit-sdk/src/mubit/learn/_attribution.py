"""Auto-attribution: credit recalled entries with a call's outcome.

Ties together recall and feedback. When entries are recalled into a prompt's
context (their IDs come from :meth:`LearnClient.get_context_with_ids`), the
result of the LLM call they informed should reinforce *those* entries. This
module normalizes the provider result into a control-plane signal
(:func:`mubit.learn._signal.normalize_outcome`) and records it with `entry_ids`
attribution, closing the recall → outcome loop automatically.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from mubit.learn._signal import normalize_outcome

__all__ = ["attribute_outcome"]


def attribute_outcome(
    client: Any,
    session_id: str,
    entry_ids: Optional[Sequence[str]],
    *,
    provider: str = "",
    response: Any = None,
    error: Optional[BaseException] = None,
    latency_ms: Optional[float] = None,
    agent_id: Optional[str] = None,
    verified_in_production: bool = False,
    rationale: str = "",
    **signal_overrides: Any,
) -> Optional[dict]:
    """Record a response-derived outcome that credits recalled entries.

    ``client`` is anything exposing ``record_outcome(session_id, *, outcome,
    signal, entry_ids, agent_id, ...)`` (e.g. ``LearnClient``). The outcome is
    derived from ``response``/``error`` via the shared normalizer. This is an
    explicit, opt-in helper (the auto path does NOT call it — HTTP success is
    not a memory-quality signal); use it when you genuinely have a provider
    result that reflects whether the recalled memory helped. No-op (returns
    ``None``) when there are no entry IDs to credit.
    """
    ids = [e for e in (entry_ids or []) if e]
    if not ids:
        return None
    norm = normalize_outcome(
        provider=provider,
        response=response,
        error=error,
        latency_ms=latency_ms,
        **signal_overrides,
    )
    # Only forward the optional kwargs when set, so any minimal record_outcome
    # (the documented contract is outcome/signal/entry_ids/agent_id) still works.
    extra = {}
    if rationale:
        extra["rationale"] = rationale
    if verified_in_production:
        extra["verified_in_production"] = True
    client.record_outcome(
        session_id,
        outcome=norm["outcome"],
        signal=norm["signal"],
        entry_ids=ids,
        agent_id=agent_id,
        **extra,
    )
    return norm
