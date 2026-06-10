"""Client error type."""

from __future__ import annotations

import httpx


class MinimaError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"minima error {status}: {detail}")
        self.status = status
        self.detail = detail


def raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        body = resp.json()
        detail = body.get("detail") or body.get("title") or str(body)
    except Exception:  # noqa: BLE001
        detail = resp.text
    raise MinimaError(resp.status_code, detail)
