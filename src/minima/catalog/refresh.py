"""Catalog refresh: fetch live cost, overlay onto snapshot, swap the store."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from minima.catalog.merge import overlay_litellm
from minima.catalog.sources.litellm import fetch_litellm_prices
from minima.catalog.store import Catalog, CatalogStore, load_aliases
from minima.config import Settings
from minima.logging import get_logger

log = get_logger("minima.catalog")


async def refresh_catalog(settings: Settings, store: CatalogStore) -> bool:
    """Best-effort refresh. Returns True if live cost was applied."""
    base = store.get()
    aliases = load_aliases()
    try:
        litellm_map = await fetch_litellm_prices(settings.minima_litellm_prices_url)
    except Exception as exc:  # noqa: BLE001 — keep last-good catalog on any failure
        log.warning("catalog_fetch_failed", error=str(exc))
        return False

    new_cards, updated = overlay_litellm(base.cards, litellm_map, aliases)
    if not updated:
        log.warning("catalog_no_models_matched", total=len(new_cards))
        return False

    store.set(
        Catalog(
            cards=new_cards,
            version=base.version,
            refreshed_at=datetime.now(UTC),
            cost_source="litellm",
            stale_after_seconds=settings.minima_catalog_stale_after_seconds,
        )
    )
    log.info("catalog_refreshed", updated=updated, total=len(new_cards))
    return True


async def refresh_loop(settings: Settings, store: CatalogStore) -> None:
    """Background loop for the app lifespan; cancelled on shutdown."""
    while True:
        try:
            await refresh_catalog(settings, store)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("catalog_refresh_loop_error", error=str(exc))
        await asyncio.sleep(settings.minima_catalog_refresh_seconds)
