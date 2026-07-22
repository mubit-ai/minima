"""Calibration endpoint — is predicted_success telling the truth for this org?"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query

from minima.api.auth import get_tenant
from minima.config import Settings
from minima.deps import get_settings
from minima.metrics.calibration import calibration_by_task_type, cusum_flags, routing_health
from minima.metrics.judge_calibration import judge_bias_stats, ppi_by_model
from minima.schemas.savings import CalibrationResponse
from minima.tenancy.context import TenantContext

router = APIRouter(prefix="/v1", tags=["calibration"])

_SECONDS_PER_DAY = 86_400.0


@router.get("/calibration", response_model=CalibrationResponse)
async def calibration(
    tenant: TenantContext = Depends(get_tenant),
    settings: Settings = Depends(get_settings),
    namespace: str | None = Query(None, description="restrict to one namespace lane"),
    days: float | None = Query(None, gt=0, le=365, description="lookback window in days"),
) -> CalibrationResponse:
    window_days = days if days is not None else float(settings.minima_calibration_window_days)
    now = time.time()
    since = now - window_days * _SECONDS_PER_DAY
    lane = f"{tenant.lane_prefix}:{namespace}" if namespace else None
    rows = (
        tenant.decision_log.rows(since=since, lane=lane)
        if tenant.decision_log is not None
        else []
    )
    return CalibrationResponse(
        org_id=tenant.org_id,
        since=since,
        days=window_days,
        namespace=namespace,
        health=routing_health(
            rows, now=now, label_maturity_hours=settings.minima_label_maturity_hours
        ),
        reports=calibration_by_task_type(
            rows,
            n_bins=settings.minima_calibration_bins,
            shrinkage_k=settings.minima_calibration_shrinkage_k,
        ),
        drift_flags=cusum_flags(
            rows, k=settings.minima_cusum_k, h=settings.minima_cusum_h
        ),
        judge_bias=judge_bias_stats(rows),
        ppi_corrected_success=ppi_by_model(rows),
    )
