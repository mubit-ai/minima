"""Strategy-exposure endpoint — surfaces the rules Mubit has promoted for a namespace."""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import APIRouter, Depends, Query

from costit.api.auth import get_tenant
from costit.logging import get_logger
from costit.schemas.strategies import StrategiesResponse, Strategy
from costit.tenancy.context import TenantContext

log = get_logger("costit.strategies")
router = APIRouter(prefix="/v1", tags=["strategies"])


@router.get("/strategies", response_model=StrategiesResponse)
async def strategies(
    namespace: str | None = None,
    lesson_types: list[str] | None = Query(default=None),
    max_strategies: int = Query(default=5, ge=1, le=50),
    tenant: TenantContext = Depends(get_tenant),
) -> StrategiesResponse:
    lane = tenant.lane(namespace)
    raw = await tenant.memory.surface_strategies(
        lane=lane, lesson_types=lesson_types, max_strategies=max_strategies
    )
    items = raw.get("strategies") if isinstance(raw, Mapping) else None
    parsed = [Strategy.from_emergent(s) for s in (items or []) if isinstance(s, Mapping)]
    return StrategiesResponse(
        namespace=namespace, lane=lane, strategies=parsed, count=len(parsed)
    )
