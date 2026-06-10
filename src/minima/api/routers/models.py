"""Model catalog endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from minima.catalog.store import CatalogStore
from minima.deps import get_catalog_store
from minima.schemas.common import TaskType
from minima.schemas.models_catalog import ModelsResponse

router = APIRouter(prefix="/v1", tags=["models"])


@router.get("/models", response_model=ModelsResponse)
async def list_models(
    provider: str | None = None,
    task_type: TaskType | None = None,
    max_cost: float | None = None,
    include_stale: bool = True,
    catalog_store: CatalogStore = Depends(get_catalog_store),
) -> ModelsResponse:
    catalog = catalog_store.get()
    cards = list(catalog.cards)

    if provider:
        cards = [c for c in cards if c.provider.lower() == provider.lower()]
    if task_type is not None:
        cards = [c for c in cards if task_type in c.capability_by_task_type]
    if max_cost is not None:
        cards = [c for c in cards if max(c.input_cost_per_mtok, c.output_cost_per_mtok) <= max_cost]
    if not include_stale:
        fresh = [c for c in cards if not c.cost_stale]
        cards = fresh or cards  # never return empty solely due to staleness

    cards.sort(key=lambda c: c.input_cost_per_mtok)
    return ModelsResponse(
        models=cards,
        catalog_version=catalog.version,
        refreshed_at=catalog.refreshed_at,
        stale=catalog.stale,
    )
