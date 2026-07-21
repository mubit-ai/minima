"""Memory-insight endpoints — Mubit introspection relays.

``POST /v1/diagnose``: failure lessons matching an error, for the harness recovery
ladder ("here's how this failed before") at re-decision time.
``GET /v1/memory/health``: per-namespace memory hygiene — stale entries,
contradictions, low-confidence counts, promotion candidates.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import APIRouter, Depends, Query

from minima.api.auth import get_tenant
from minima.logging import get_logger
from minima.schemas.insight import (
    DiagnoseRequest,
    DiagnoseResponse,
    FailureLesson,
    MemoryHealthResponse,
)
from minima.tenancy.context import TenantContext

log = get_logger("minima.insight")
router = APIRouter(prefix="/v1", tags=["insight"])


@router.post("/diagnose", response_model=DiagnoseResponse)
async def diagnose(
    req: DiagnoseRequest,
    tenant: TenantContext = Depends(get_tenant),
) -> DiagnoseResponse:
    lane = tenant.lane(req.namespace)
    # Degrade like the recommend hot path: a Mubit outage must not 500 this read.
    try:
        raw = await tenant.memory.diagnose(
            lane=lane,
            error_text=req.error_text,
            error_type=req.error_type,
            limit=req.limit,
            user_id=req.user_id,
        )
    except Exception as exc:  # noqa: BLE001 — memory unavailability must never break the read
        log.warning("diagnose_failed", lane=lane, error=str(exc))
        return DiagnoseResponse(
            namespace=req.namespace, lane=lane, warnings=["memory_unavailable"]
        )
    data: Mapping = raw if isinstance(raw, Mapping) else {}
    lessons = [
        FailureLesson.from_raw(item)
        for item in (data.get("failure_lessons") or [])
        if isinstance(item, Mapping)
    ]
    return DiagnoseResponse(
        namespace=req.namespace,
        lane=lane,
        failure_lessons=lessons,
        summary=str(data.get("summary", "")),
        total_failure_lessons=int(data.get("total_failure_lessons", len(lessons)) or 0),
    )


@router.get("/memory/health", response_model=MemoryHealthResponse)
async def memory_health(
    namespace: str | None = None,
    stale_threshold_days: int = Query(default=30, ge=1, le=365),
    tenant: TenantContext = Depends(get_tenant),
) -> MemoryHealthResponse:
    lane = tenant.lane(namespace)
    try:
        raw = await tenant.memory.memory_health(
            lane=lane, stale_threshold_days=stale_threshold_days
        )
    except Exception as exc:  # noqa: BLE001 — memory unavailability must never break the read
        log.warning("memory_health_failed", lane=lane, error=str(exc))
        return MemoryHealthResponse(
            namespace=namespace, lane=lane, warnings=["memory_unavailable"]
        )
    data: Mapping = raw if isinstance(raw, Mapping) else {}
    counts = data.get("entry_counts")
    section = data.get("section_health")
    return MemoryHealthResponse(
        namespace=namespace,
        lane=lane,
        entry_counts={str(k): int(v) for k, v in counts.items()}
        if isinstance(counts, Mapping)
        else {},
        stale_entries=int(data.get("stale_entries", 0) or 0),
        contradictions=int(data.get("contradictions", 0) or 0),
        low_confidence_count=int(data.get("low_confidence_count", 0) or 0),
        promotion_candidates=int(data.get("promotion_candidates", 0) or 0),
        section_health=dict(section) if isinstance(section, Mapping) else {},
    )
