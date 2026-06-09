"""Multi-tenancy: per-org routing to each org's own Mubit instance (T3).

Off by default (``costit_multitenant=False``) — Costit then runs single-tenant against
the env Mubit key, exactly as before. When enabled, a Costit-issued key
(``cstk_<org>_<keyid>_<secret>``) is resolved server-side to the org's Mubit instance
(endpoint + data-plane key, held as a secret reference, never sent by the caller).
"""

from __future__ import annotations

from costit.tenancy.context import TenantContext
from costit.tenancy.keys import generate_costit_key, parse_costit_key, verify_secret
from costit.tenancy.registry import TenantRecord, TenantStore, build_tenant_store
from costit.tenancy.runtime import TenantRuntime
from costit.tenancy.secrets import SecretResolver

__all__ = [
    "SecretResolver",
    "TenantContext",
    "TenantRecord",
    "TenantRuntime",
    "TenantStore",
    "build_tenant_store",
    "generate_costit_key",
    "parse_costit_key",
    "verify_secret",
]
