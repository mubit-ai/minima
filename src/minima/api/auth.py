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


def is_mubit_key_format(key: str) -> bool:
    """Cheap client-side shape check for a canonical Mubit key.

    Canonical keys are ``mbt_<instance>_...`` (see tenancy.passthrough._org_id). This is
    a front-door format gate only — it rejects tokens that clearly are not Mubit keys
    (e.g. ``not-a-key``) before any work is done, without a Mubit round-trip. It does NOT
    authenticate the key; a well-formed key still resolves normally (and works offline
    from local priors). Kept deliberately permissive to avoid locking out real callers:
    the only requirement is an ``mbt_`` prefix followed by a non-empty instance segment.
    """
    prefix, sep, rest = key.partition("_")
    return prefix == "mbt" and sep == "_" and bool(rest)


def configured_key(request: Request) -> str | None:
    settings = getattr(request.app.state, "settings", None)
    key = getattr(settings, "mubit_api_key", None)
    return key.strip() if isinstance(key, str) and key.strip() else None


async def get_tenant(request: Request) -> TenantContext:
    token = bearer_key(request)
    if token is not None and not is_mubit_key_format(token):
        raise ApiError(
            401,
            "Unauthorized",
            "Authorization bearer token is not a valid Mubit API key (expected 'mbt_...' format)",
        )
    key = token or configured_key(request)
    if not key:
        raise ApiError(
            401,
            "Unauthorized",
            "configure MUBIT_API_KEY or pass your Mubit API key as: Authorization: Bearer <key>",
        )
    return request.app.state.passthrough_runtime.resolve(key)


async def get_tenant_optional(request: Request) -> TenantContext | None:
    """Like get_tenant but returns None instead of 401 (for health probes)."""
    token = bearer_key(request)
    if token is not None and not is_mubit_key_format(token):
        return None
    key = token or configured_key(request)
    if not key:
        return None
    return request.app.state.passthrough_runtime.resolve(key)
