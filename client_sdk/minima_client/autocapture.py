"""Optional zero-code intake: route ``mubit.learn`` auto-capture into Minima's lane.

This is a thin, opinionated wrapper over ``mubit.learn``. Calling :func:`enable` pins
the learn run to the same memory lane Minima recalls from (``minima:<namespace>``) and a
stable ``minima-autocapture`` agent id, then monkeypatches the caller's
OpenAI/Anthropic/LiteLLM/Google-GenAI clients so every LLM call auto-ingests its trace
and gets relevant lessons injected — no code changes at the call site.

What this does and does NOT do:
- It DOES land traces + lessons in Minima's lane, so they enrich the reasoner's memory
  block (``get_context``) and Mubit's own reflection/strategy promotion.
- It does NOT, on its own, produce Minima *outcome records* (the ``kind="outcome"``
  rows the deterministic k-NN aggregator scores), and ``mubit.learn`` never fabricates
  a success signal. To close the loop, either call :func:`feedback` (credits the
  recalled entries) or send a quality score to Minima's ``POST /v1/feedback``.

``mubit-sdk`` is required; everything here imports it lazily so importing this module
never fails, and each call raises a clear error if the SDK is absent.
"""

from __future__ import annotations

from typing import Any

DEFAULT_AGENT_ID = "minima-autocapture"
DEFAULT_LANE_PREFIX = "minima"


def lane_for(namespace: str | None, prefix: str = DEFAULT_LANE_PREFIX) -> str:
    """Minima's lane convention — must match the server's ``Settings.lane``."""
    return f"{prefix}:{namespace or 'default'}"


def _learn() -> Any:
    try:
        import mubit.learn as learn
    except Exception as exc:  # ImportError or a partial install
        raise RuntimeError(
            "minima_client.autocapture requires mubit-sdk (mubit.learn). "
            "Install it with: pip install mubit-sdk"
        ) from exc
    return learn


def enable(
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
    namespace: str = "default",
    user_id: str = "",
    agent_id: str = DEFAULT_AGENT_ID,
    lane_prefix: str = DEFAULT_LANE_PREFIX,
    inject_lessons: bool = True,
    auto_extract: bool = True,
    **init_kwargs: Any,
) -> Any:
    """Start a ``mubit.learn`` session scoped to Minima's lane and return the RunManager.

    Extra keyword arguments pass straight through to ``mubit.learn.init`` (e.g.
    ``patch_globals=False`` to opt out of global monkeypatching and use :func:`wrap`).
    """
    return _learn().init(
        api_key=api_key,
        endpoint=endpoint,
        agent_id=agent_id,
        user_id=user_id,
        lane=lane_for(namespace, lane_prefix),
        inject_lessons=inject_lessons,
        auto_extract=auto_extract,
        **init_kwargs,
    )


def feedback(score: float | None = None, *, good: bool | None = None, **kwargs: Any) -> None:
    """Credit the memories recalled for the most recent call (closes the loop).

    Provide one signal: ``good=True/False`` or ``score`` in [-1, 1]. Passes through to
    ``mubit.learn.feedback`` (supports ``entry_ids``, ``verified_in_production``, etc.).
    """
    _learn().feedback(score, good=good, **kwargs)


def wrap(client: Any, **kwargs: Any) -> Any:
    """Explicitly enrich a single LLM client instead of global patching.

    Thin pass-through to ``mubit.learn.wrap``.
    """
    return _learn().wrap(client, **kwargs)


def capture(messages: list[dict[str, Any]], response: str, **kwargs: Any) -> None:
    """Manually ingest one interaction (for raw HTTP / unsupported libs).

    Thin pass-through to ``mubit.learn.capture``.
    """
    _learn().capture(messages, response, **kwargs)


def disable() -> None:
    """Restore original LLM client behavior and stop the learn session."""
    _learn().uninstrument()
