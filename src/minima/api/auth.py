"""Auth dependencies: resolve the caller's Minima key to a TenantContext.

Single-tenant (multitenant off): every request maps to the one ``default`` tenant built
from the env Mubit key — no credential required, behaviour unchanged. Multi-tenant: the
caller presents ``Authorization: Bearer mnim_<org>_<keyid>_<secret>`` which is resolved
server-side to that org's own Mubit instance; a missing/invalid key is rejected 401.
"""

from __future__ import annotations

import hmac

from fastapi import Request

from minima.api.errors import ApiError
from minima.tenancy.context import TenantContext


def bearer_key(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


async def get_tenant(request: Request) -> TenantContext:
    runtime = getattr(request.app.state, "tenant_runtime", None)
    if runtime is None:  # single-tenant
        return request.app.state.default_tenant
    ctx = runtime.resolve(bearer_key(request))
    if ctx is None:
        raise ApiError(401, "Unauthorized", "missing or invalid Minima API key")
    return ctx


async def get_tenant_optional(request: Request) -> TenantContext | None:
    """Like ``get_tenant`` but returns ``None`` instead of 401 (for liveness/health)."""
    runtime = getattr(request.app.state, "tenant_runtime", None)
    if runtime is None:
        return getattr(request.app.state, "default_tenant", None)
    return runtime.resolve(bearer_key(request))


def require_provisioning(request: Request) -> None:
    """Guard the admin/provisioning endpoints with the provisioning key (constant-time)."""
    settings = request.app.state.settings
    if not settings.minima_multitenant:
        raise ApiError(404, "Not Found", "multi-tenancy is disabled")
    expected = settings.minima_provisioning_key
    presented = request.headers.get("x-minima-provisioning-key")
    if not expected or not presented or not hmac.compare_digest(presented, expected):
        raise ApiError(403, "Forbidden", "invalid or missing provisioning key")
