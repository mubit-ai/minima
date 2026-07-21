"""Savings endpoint — counterfactual cost accounting from the decision log.

Tenant-scoped: a caller sees only their own org's decisions (the decision log handed
to this router is already org-bound by the pass-through runtime).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query

from minima.api.auth import get_tenant
from minima.config import Settings
from minima.deps import get_settings
from minima.metrics.calibration import routing_health
from minima.metrics.ope import regret_report, replay_policy_value
from minima.metrics.savings import group_rows, summarize
from minima.schemas.savings import PolicyValueResponse, SavingsGroup, SavingsResponse
from minima.tenancy.context import TenantContext

router = APIRouter(prefix="/v1", tags=["savings"])

_SECONDS_PER_DAY = 86_400.0

_CHALLENGER_POLICIES = ("discounted", "raw_argmin")


@router.get("/savings", response_model=SavingsResponse)
async def savings(
    tenant: TenantContext = Depends(get_tenant),
    settings: Settings = Depends(get_settings),
    namespace: str | None = Query(None, description="restrict to one namespace lane"),
    days: float = Query(30.0, gt=0, le=365, description="lookback window in days"),
    group_by: str | None = Query(
        None, pattern="^(cluster|task_type|lane)$", description="optional breakdown"
    ),
) -> SavingsResponse:
    now = time.time()
    since = now - days * _SECONDS_PER_DAY
    maturity = settings.minima_label_maturity_hours
    lane = f"{tenant.lane_prefix}:{namespace}" if namespace else None
    rows = (
        tenant.decision_log.rows(since=since, lane=lane)
        if tenant.decision_log is not None
        else []
    )
    summary = summarize(rows)
    health = routing_health(rows, now=now, label_maturity_hours=maturity)
    groups = [
        SavingsGroup(
            key=key,
            summary=summarize(group),
            health=routing_health(group, now=now, label_maturity_hours=maturity),
        )
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


@router.get("/policy-value", response_model=PolicyValueResponse)
async def policy_value(
    tenant: TenantContext = Depends(get_tenant),
    namespace: str | None = Query(None, description="restrict to one namespace lane"),
    days: float = Query(30.0, gt=0, le=365, description="lookback window in days"),
) -> PolicyValueResponse:
    """Regret-vs-oracle: policy-value estimator suite over trusted reconciled decisions."""
    since = time.time() - days * _SECONDS_PER_DAY
    lane = f"{tenant.lane_prefix}:{namespace}" if namespace else None
    rows = (
        tenant.decision_log.rows(since=since, lane=lane)
        if tenant.decision_log is not None
        else []
    )
    report = regret_report(rows)
    challengers = [
        est
        for name in _CHALLENGER_POLICIES
        if (est := replay_policy_value(rows, name)) is not None
    ]
    warnings = ["estimator_disagreement"] if report.estimator_disagreement else []
    return PolicyValueResponse(
        org_id=tenant.org_id,
        since=since,
        days=days,
        namespace=namespace,
        report=report,
        challengers=challengers,
        warnings=warnings,
    )
