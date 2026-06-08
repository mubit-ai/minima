"""Fetch the OpenRouter model list (pricing + context windows).

Used as a secondary reconciliation source; wired into refresh in a later phase.
"""

from __future__ import annotations

from typing import Any

import httpx


async def fetch_openrouter_models(
    url: str, api_key: str | None = None, timeout: float = 20.0
) -> dict[str, dict[str, Any]]:
    """Return ``{model_id: model_object}`` keyed by OpenRouter id, or {} on failure shape."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return {}
    return {str(row.get("id")): row for row in rows if isinstance(row, dict) and row.get("id")}
