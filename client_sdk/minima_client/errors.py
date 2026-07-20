"""Client error types."""

from __future__ import annotations

import httpx


class MinimaError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"minima error {status}: {detail}")
        self.status = status
        self.detail = detail


class MinimaRateLimited(MinimaError):
    """429 — the server asked us to slow down; retry_after is seconds when provided."""

    def __init__(self, status: int, detail: str, retry_after: float | None = None):
        super().__init__(status, detail)
        self.retry_after = retry_after


class MinimaUnavailable(MinimaError):
    """502/503/504 — transient upstream trouble; safe to retry idempotent calls."""


def _retry_after_seconds(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        body = resp.json()
        detail = body.get("detail") or body.get("title") or str(body)
    except Exception:  # noqa: BLE001
        detail = resp.text
    if resp.status_code == 429:
        raise MinimaRateLimited(resp.status_code, detail, _retry_after_seconds(resp))
    if resp.status_code in (502, 503, 504):
        raise MinimaUnavailable(resp.status_code, detail)
    raise MinimaError(resp.status_code, detail)
