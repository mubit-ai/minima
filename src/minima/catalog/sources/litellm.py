"""Fetch the LiteLLM community price map (per-token costs for thousands of models)."""

from __future__ import annotations

from typing import Any

import httpx


async def fetch_litellm_prices(url: str, timeout: float = 20.0) -> dict[str, Any]:
    """Return the raw ``{model_key: {...cost fields...}}`` map.

    Raises on network/HTTP error; callers treat failure as "keep last-good catalog".
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
    return data if isinstance(data, dict) else {}
