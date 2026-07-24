"""Health endpoint — always 200; reports degraded state in the body."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from minima.api.auth import get_tenant_optional
from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.deps import get_catalog_store, get_passthrough_runtime, get_settings
from minima.recommender.classify import CLASSIFIER_ID
from minima.tenancy.context import TenantContext
from minima.tenancy.passthrough import PassthroughRuntime
from minima.version import __version__

router = APIRouter(prefix="/v1", tags=["health"])


@router.get("/health")
async def health(
    tenant: TenantContext | None = Depends(get_tenant_optional),
    catalog_store: CatalogStore = Depends(get_catalog_store),
    settings: Settings = Depends(get_settings),
    runtime: PassthroughRuntime = Depends(get_passthrough_runtime),
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
    embed = runtime.embed_classifier
    return {
        "status": "ok" if reachable or reachable is None else "degraded",
        "mubit": mubit,
        "auth": "passthrough",
        "classifier": {
            "id": embed.classifier_id if embed is not None else CLASSIFIER_ID,
            "embed_loaded": embed is not None,
            "required": settings.minima_classifier_required,
        },
        "catalog": {
            "version": catalog.version,
            "cost_source": catalog.cost_source,
            "stale": catalog.stale,
            "models": len(catalog.cards),
        },
        "version": __version__,
    }
