"""Health endpoint — always 200; reports degraded state in the body."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from costit.catalog.store import CatalogStore
from costit.config import Settings
from costit.deps import get_catalog_store, get_memory, get_settings
from costit.memory.adapter import Memory
from costit.version import __version__

router = APIRouter(prefix="/v1", tags=["health"])


@router.get("/health")
async def health(
    memory: Memory = Depends(get_memory),
    catalog_store: CatalogStore = Depends(get_catalog_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mubit = await memory.health()
    catalog = catalog_store.get()
    return {
        "status": "ok" if mubit.get("reachable") else "degraded",
        "mubit": {**mubit, "endpoint": settings.mubit_endpoint},
        "catalog": {
            "version": catalog.version,
            "cost_source": catalog.cost_source,
            "stale": catalog.stale,
            "models": len(catalog.cards),
        },
        "reasoner": {
            "provider": settings.costit_reasoner_provider,
            "configured": settings.reasoner_enabled,
        },
        "version": __version__,
    }
