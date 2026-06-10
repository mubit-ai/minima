"""Overlay live cost data onto the static capability snapshot."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from minima.schemas.models_catalog import ModelCard


def _per_mtok(per_token: Any) -> float | None:
    try:
        return float(per_token) * 1_000_000.0
    except (TypeError, ValueError):
        return None


def overlay_litellm(
    cards: list[ModelCard],
    litellm_map: dict[str, Any],
    aliases: dict[str, list[str]],
) -> tuple[list[ModelCard], int]:
    """Return (new cards with live cost where matched, number updated)."""
    now = datetime.now(UTC)
    out: list[ModelCard] = []
    updated = 0

    for card in cards:
        keys = aliases.get(card.model_id, [card.model_id])
        entry: dict[str, Any] | None = None
        for key in keys:
            candidate = litellm_map.get(key)
            if isinstance(candidate, dict):
                entry = candidate
                break
        if entry is None:
            out.append(card)
            continue

        in_cost = _per_mtok(entry.get("input_cost_per_token"))
        out_cost = _per_mtok(entry.get("output_cost_per_token"))
        cache_cost = _per_mtok(entry.get("cache_read_input_token_cost"))
        ctx = entry.get("max_input_tokens") or entry.get("max_tokens")

        out.append(
            card.model_copy(
                update={
                    "input_cost_per_mtok": in_cost
                    if in_cost is not None
                    else card.input_cost_per_mtok,
                    "output_cost_per_mtok": out_cost
                    if out_cost is not None
                    else card.output_cost_per_mtok,
                    "cache_read_cost_per_mtok": cache_cost
                    if cache_cost is not None
                    else card.cache_read_cost_per_mtok,
                    "context_window": int(ctx) if ctx else card.context_window,
                    "supports_prompt_caching": bool(
                        entry.get("supports_prompt_caching", card.supports_prompt_caching)
                    ),
                    "cost_source": "litellm",
                    "cost_fetched_at": now,
                    "cost_stale": False,
                }
            )
        )
        updated += 1

    return out, updated
