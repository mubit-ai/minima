"""Auth dependency: resolve the caller's Mubit API key to a TenantContext.

Pass-through mode: the caller presents their own Mubit key as
``Authorization: Bearer <mubit_api_key>``. Minima uses it directly against
MUBIT_ENDPOINT; no Minima-issued keys, no provisioning step.
"""

from __future__ import annotations

from fastapi import Request

from minima.api.errors import ApiError
from minima.tenancy.context import TenantContext


def bearer_key(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def configured_key(request: Request) -> str | None:
    settings = getattr(request.app.state, "settings", None)
    key = getattr(settings, "mubit_api_key", None)
    return key.strip() if isinstance(key, str) and key.strip() else None


async def get_tenant(request: Request) -> TenantContext:
    key = bearer_key(request) or configured_key(request)
    if not key:
        raise ApiError(
            401,
            "Unauthorized",
            "configure MUBIT_API_KEY or pass your Mubit API key as: Authorization: Bearer <key>",
        )
    return request.app.state.passthrough_runtime.resolve(key)


async def get_tenant_optional(request: Request) -> TenantContext | None:
    """Like get_tenant but returns None instead of 401 (for health probes)."""
    key = bearer_key(request) or configured_key(request)
    if not key:
        return None
    return request.app.state.passthrough_runtime.resolve(key)
