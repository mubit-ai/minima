"""Retry-with-exponential-backoff helpers for the Mubit Python SDK.

Wraps `Client.invoke` so transient transport / 5xx failures are retried
automatically. Non-retryable errors (auth, validation, schema) surface on the
first attempt.

Configured via env vars:
- MUBIT_RETRY_ATTEMPTS (default: 3, min: 1) — total attempts including first.
- MUBIT_RETRY_BASE_MS  (default: 200)       — base delay in ms.
- MUBIT_RETRY_CAP_MS   (default: 5000)      — max delay per retry.
- MUBIT_RETRY_JITTER   (default: 0.2)       — ±fraction of jitter (0.0 = off).
"""

from __future__ import annotations

import os
import random
import time
from typing import Any, Callable, Optional


_DEFAULT_ATTEMPTS = 3
_DEFAULT_BASE_MS = 200
_DEFAULT_CAP_MS = 5000
_DEFAULT_JITTER = 0.2


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw.strip())
    except (ValueError, AttributeError):
        return default
    return max(value, minimum)


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw.strip())
    except (ValueError, AttributeError):
        return default
    return max(value, minimum)


def attempts() -> int:
    return _env_int("MUBIT_RETRY_ATTEMPTS", _DEFAULT_ATTEMPTS, 1)


def base_ms() -> int:
    return _env_int("MUBIT_RETRY_BASE_MS", _DEFAULT_BASE_MS, 10)


def cap_ms() -> int:
    return _env_int("MUBIT_RETRY_CAP_MS", _DEFAULT_CAP_MS, _DEFAULT_BASE_MS)


def jitter() -> float:
    return _env_float("MUBIT_RETRY_JITTER", _DEFAULT_JITTER, 0.0)


def is_retryable(exc: BaseException) -> bool:
    """True if the exception represents a transient failure worth retrying."""
    # Import locally to avoid cyclic imports.
    from .client import TransportError, ServerError  # type: ignore

    if isinstance(exc, TransportError):
        # Map well-known transient codes.
        code = getattr(exc, "code", None)
        if code in {
            "UNAVAILABLE",
            "DEADLINE_EXCEEDED",
            "RESOURCE_EXHAUSTED",
            "ABORTED",
            "INTERNAL",
            "CANCELLED",
            "CONNECTION_ERROR",
            "TIMEOUT",
        }:
            return True
        return False
    if isinstance(exc, ServerError):
        # ServerError wraps HTTP 5xx — always retry.
        return True
    return False


def backoff_delay_seconds(attempt: int) -> float:
    """Compute exponential backoff with jitter for an attempt index (1-based)."""
    if attempt <= 1:
        return 0.0
    exp = min(base_ms() * (2 ** (attempt - 2)), cap_ms())
    j = jitter()
    if j > 0:
        # Symmetric jitter: [(1-j), (1+j)] * exp.
        factor = 1.0 + random.uniform(-j, j)
        exp = max(0.0, exp * factor)
    return exp / 1000.0


def call_with_retry(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run `func` with retry on transient errors.

    Retries sleep synchronously via `time.sleep`. Non-retryable errors bubble up
    on the first attempt. The last exception is re-raised when retries are
    exhausted so callers never see a generic retry wrapper error.
    """
    total = attempts()
    last_exc: Optional[BaseException] = None
    for attempt in range(1, total + 1):
        if attempt > 1:
            delay = backoff_delay_seconds(attempt)
            if delay > 0:
                time.sleep(delay)
        try:
            return func(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 — we re-raise non-retryable
            if not is_retryable(exc) or attempt >= total:
                raise
            last_exc = exc
    # Should be unreachable — loop either returns or raises.
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("retry loop exited without result or exception")
