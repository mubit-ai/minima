"""
MuBit Auto-Capture Context Management.

This module provides the contextvars-based span tree that links LLM calls to their
enclosing logical step (function decorated with @observe) and manages capture state.
"""

import contextvars
import functools
import inspect
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Client classes whose methods are coroutines. Used as a robust fallback when
# inspect-based detection fails (e.g. already-wrapped bound methods on the
# OpenAI/Anthropic v2.x clients return False from iscoroutinefunction).
_ASYNC_CLIENT_NAMES = frozenset(
    {"AsyncOpenAI", "AsyncAzureOpenAI", "AsyncAnthropic", "AsyncAnthropicBedrock"}
)


def is_async_callable(fn: Any) -> bool:
    """Best-effort detection of an async callable.

    `inspect.iscoroutinefunction` is the primary signal, with fallbacks for the
    `_is_coroutine` marker and `functools.partial`/`__wrapped__` chains. This is
    only a *fallback*: the wrappers prefer an explicit `is_async` flag derived
    from the concrete client class (see `is_async_client`), which is reliable
    where `inspect` is not.
    """
    seen = 0
    cur = fn
    while cur is not None and seen < 5:
        if inspect.iscoroutinefunction(cur):
            return True
        if getattr(cur, "_is_coroutine", None) is True:
            return True
        nxt = getattr(cur, "func", None) or getattr(cur, "__wrapped__", None)
        cur = nxt
        seen += 1
    return False


def is_async_client(client: Any) -> bool:
    """True if `client` is an async LLM client, decided by its class name/MRO.

    Reliable where `is_async_callable` is not: the concrete instance's type is
    known even when its bound methods have been re-wrapped.
    """
    try:
        for klass in type(client).__mro__:
            if klass.__name__ in _ASYNC_CLIENT_NAMES:
                return True
    except Exception:
        pass
    return False

# Current active span (if any)
_current_span: contextvars.ContextVar[Optional["Span"]] = contextvars.ContextVar(
    "mubit_auto_span", default=None
)

# Global capture toggle
_capture_enabled: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "mubit_auto_capture", default=True
)


@dataclass
class Span:
    """A logical unit of work (trace span) that groups LLM interactions."""

    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])
    parent_id: Optional[str] = None
    name: str = ""
    agent_id: str = "auto"
    session_id: str = ""
    user_id: str = ""
    start_time: float = field(default_factory=time.monotonic)
    items: List[Dict[str, Any]] = field(default_factory=list)
    # Entry IDs recalled into the most recent LLM call's context, stashed by the
    # learn wrappers so a later mubit.learn.feedback() can credit exactly those
    # entries (recall -> feedback attribution) without the caller tracking IDs.
    recalled_entry_ids: List[str] = field(default_factory=list)

    def add_item(self, item: Dict[str, Any]) -> None:
        """Link an ingest item to this span."""
        # Note: metadata_json manipulation happens at item build time,
        # but we track items here for future aggregation if needed.
        self.items.append(item)


def get_current_span() -> Optional[Span]:
    """Get the currently active span from contextvars."""
    return _current_span.get()


def set_current_span(span: Optional[Span]) -> contextvars.Token:
    """Set the currently active span."""
    return _current_span.set(span)


def is_capture_enabled() -> bool:
    """Check if auto-capture is currently enabled."""
    return _capture_enabled.get()


@contextmanager
def no_capture():
    """Context manager to temporarily disable auto-capture."""
    token = _capture_enabled.set(False)
    try:
        yield
    finally:
        _capture_enabled.reset(token)
