"""Tenant provisioning — mint/list/revoke Minima keys (provisioning-key guarded).

Active only when ``minima_multitenant`` is on; ``require_provisioning`` returns 404
otherwise and 403 without a valid ``X-Minima-Provisioning-Key``. The provisioning key is
the admin credential (LiteLLM master-key model): it mints per-org keys and is never
handed to callers.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request

from minima.api.auth import require_provisioning
from minima.api.errors import ApiError
from minima.logging import get_logger
from minima.schemas.admin import (
    TenantCreateRequest,
    TenantCreateResponse,
    TenantDeleteResponse,
    TenantListResponse,
    TenantSummary,
)
from minima.tenancy.keys import generate_minima_key, normalize_org_id
from minima.tenancy.registry import TenantRecord, TenantStore

log = get_logger("minima.admin")
router = APIRouter(prefix="/v1/admin", tags=["admin"], dependencies=[Depends(require_provisioning)])


def _store(request: Request) -> TenantStore:
    store = getattr(request.app.state, "tenant_store", None)
    if store is None:  # defensive — require_provisioning already gated multitenant
        raise ApiError(404, "Not Found", "tenant store unavailable")
    return store


@router.post("/tenants", response_model=TenantCreateResponse, status_code=201)
async def create_tenant(req: TenantCreateRequest, request: Request) -> TenantCreateResponse:
    store = _store(request)
    try:
        org = normalize_org_id(req.org_id)
    except ValueError as exc:
        raise ApiError(400, "Invalid request", str(exc)) from exc
    if store.get(org) is not None:
        raise ApiError(409, "Conflict", f"org '{org}' already exists; delete it first to re-key")

    key_id, secret_hash, full_key = generate_minima_key(org)
    created_at = time.time()
    store.put(
        TenantRecord(
            org_id=org,
            mubit_endpoint=req.mubit_endpoint,
            mubit_api_key_ref=req.mubit_api_key_ref,
            key_id=key_id,
            secret_hash=secret_hash,
            mubit_transport=req.mubit_transport,
            lane_prefix=req.lane_prefix,
            reads_shared_seed=req.reads_shared_seed,
            created_at=created_at,
        )
    )
    log.info("tenant_created", org_id=org, key_id=key_id, endpoint=req.mubit_endpoint)
    return TenantCreateResponse(
        org_id=org, key_id=key_id, minima_api_key=full_key, created_at=created_at
    )


@router.get("/tenants", response_model=TenantListResponse)
async def list_tenants(request: Request) -> TenantListResponse:
    records = _store(request).list()
    tenants = [
        TenantSummary(
            org_id=r.org_id,
            mubit_endpoint=r.mubit_endpoint,
            mubit_transport=r.mubit_transport,
            lane_prefix=r.lane_prefix,
            reads_shared_seed=r.reads_shared_seed,
            key_id=r.key_id,
            created_at=r.created_at,
        )
        for r in records
    ]
    return TenantListResponse(tenants=tenants, count=len(tenants))


@router.delete("/tenants/{org_id}", response_model=TenantDeleteResponse)
async def delete_tenant(org_id: str, request: Request) -> TenantDeleteResponse:
    deleted = _store(request).delete(org_id)
    if deleted:
        log.info("tenant_deleted", org_id=org_id)
    return TenantDeleteResponse(org_id=org_id, deleted=deleted)
