"""Schemas for tenant provisioning (admin/provisioning-key guarded)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TenantCreateRequest(BaseModel):
    org_id: str = Field(..., description="1-63 chars [a-z0-9-], starts alphanumeric")
    mubit_endpoint: str = Field(..., description="the org's own Mubit instance URL")
    mubit_api_key_ref: str = Field(
        ...,
        description=(
            "reference to the org's Mubit data-plane key: 'env:NAME' (recommended), "
            "'inline:VALUE' (dev), or 'vault:path' (future). The raw key is never stored "
            "in the clear when a real backend is used."
        ),
    )
    mubit_transport: str = Field("http", description="http | grpc | auto")
    lane_prefix: str = Field("costit", description="intra-org lane prefix")
    reads_shared_seed: bool = Field(
        False, description="reserved: read a Costit-owned warm-start reference instance"
    )


class TenantCreateResponse(BaseModel):
    org_id: str
    key_id: str
    # Shown ONCE at creation; only a hash is persisted and it cannot be recovered later.
    costit_api_key: str
    created_at: float


class TenantSummary(BaseModel):
    org_id: str
    mubit_endpoint: str
    mubit_transport: str
    lane_prefix: str
    reads_shared_seed: bool
    key_id: str
    created_at: float


class TenantListResponse(BaseModel):
    tenants: list[TenantSummary] = Field(default_factory=list)
    count: int = 0


class TenantDeleteResponse(BaseModel):
    org_id: str
    deleted: bool
