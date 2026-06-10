"""Multi-tenancy: per-org routing to each org's own Mubit instance (T3).

Off by default (``minima_multitenant=False``) — Minima then runs single-tenant against
the env Mubit key, exactly as before. When enabled, a Minima-issued key
(``mnim_<org>_<keyid>_<secret>``) is resolved server-side to the org's Mubit instance
(endpoint + data-plane key, held as a secret reference, never sent by the caller).
"""

from __future__ import annotations

from minima.tenancy.context import TenantContext
from minima.tenancy.keys import generate_minima_key, parse_minima_key, verify_secret
from minima.tenancy.registry import TenantRecord, TenantStore, build_tenant_store
from minima.tenancy.runtime import TenantRuntime
from minima.tenancy.secrets import SecretResolver

__all__ = [
    "SecretResolver",
    "TenantContext",
    "TenantRecord",
    "TenantRuntime",
    "TenantStore",
    "build_tenant_store",
    "generate_minima_key",
    "parse_minima_key",
    "verify_secret",
]
