"""Savings endpoint — counterfactual cost accounting from the decision log.

Tenant-scoped: a caller sees only their own org's decisions (the decision log handed
to this router is already org-bound by the pass-through runtime).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query

from minima.api.auth import get_tenant
from minima.metrics.calibration import routing_health
from minima.metrics.savings import group_rows, summarize
from minima.schemas.savings import SavingsGroup, SavingsResponse
from minima.tenancy.context import TenantContext

router = APIRouter(prefix="/v1", tags=["savings"])

_SECONDS_PER_DAY = 86_400.0


@router.get("/savings", response_model=SavingsResponse)
async def savings(
    tenant: TenantContext = Depends(get_tenant),
    namespace: str | None = Query(None, description="restrict to one namespace lane"),
    days: float = Query(30.0, gt=0, le=365, description="lookback window in days"),
    group_by: str | None = Query(
        None, pattern="^(cluster|task_type|lane)$", description="optional breakdown"
    ),
) -> SavingsResponse:
    since = time.time() - days * _SECONDS_PER_DAY
    lane = f"{tenant.lane_prefix}:{namespace}" if namespace else None
    rows = (
        tenant.decision_log.rows(since=since, lane=lane)
        if tenant.decision_log is not None
        else []
    )
    summary = summarize(rows)
    health = routing_health(rows)
    groups = [
        SavingsGroup(key=key, summary=summarize(group), health=routing_health(group))
        for key, group in sorted(group_rows(rows, group_by).items())
    ]
    return SavingsResponse(
        org_id=tenant.org_id,
        since=since,
        days=days,
        namespace=namespace,
        summary=summary,
        health=health,
        group_by=group_by,
        groups=groups,
    )
