"""Health endpoint — always 200; reports degraded state in the body."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from minima.api.auth import get_tenant_optional
from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.deps import get_catalog_store, get_settings
from minima.tenancy.context import TenantContext
from minima.version import __version__

router = APIRouter(prefix="/v1", tags=["health"])


@router.get("/health")
async def health(
    tenant: TenantContext | None = Depends(get_tenant_optional),
    catalog_store: CatalogStore = Depends(get_catalog_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    catalog = catalog_store.get()
    # In multi-tenant mode an unauthenticated probe still gets service liveness; the
    # Mubit block is reported only when a valid Minima key resolves an org's instance.
    if tenant is None:
        mubit: dict[str, Any] = {"reachable": None, "scope": "unauthenticated"}
    else:
        mubit = await tenant.memory.health()
        mubit["endpoint"] = tenant.mubit_endpoint
        mubit["org_id"] = tenant.org_id
    reachable = mubit.get("reachable")
    return {
        "status": "ok" if reachable or reachable is None else "degraded",
        "mubit": mubit,
        "auth": "passthrough",
        "catalog": {
            "version": catalog.version,
            "cost_source": catalog.cost_source,
            "stale": catalog.stale,
            "models": len(catalog.cards),
        },
        "version": __version__,
    }
