"""Resolve a stored secret *reference* to the real value at use time.

The tenant registry never stores a raw Mubit key in the clear by default — it stores a
reference, and the real secret lives where the deployment already keeps secrets:

- ``env:NAME``      -> os.environ["NAME"]   (recommended; works with any secret manager
                       that injects env vars, e.g. K8s secrets / Vault Agent / SOPS)
- ``inline:VALUE``  -> VALUE                (dev/local convenience; logged as a warning)
- bare ``VALUE``    -> treated as inline    (back-compat; logged as a warning)

A real vault backend (``vault:path``) can be added here without touching call sites.
"""

from __future__ import annotations

import os

from minima.logging import get_logger

log = get_logger("minima.tenancy.secrets")


class SecretResolver:
    def resolve(self, ref: str | None) -> str | None:
        if ref is None:
            return None
        ref = ref.strip()
        if not ref:
            return None
        scheme, _, rest = ref.partition(":")
        if _ == ":" and scheme == "env":
            value = os.environ.get(rest)
            if value is None:
                log.warning("secret_env_missing", var=rest)
            return value
        if _ == ":" and scheme == "inline":
            log.warning("secret_inline_used", detail="inline secret ref; use env:/vault: in prod")
            return rest
        if _ == ":" and scheme == "vault":
            log.warning("secret_vault_unsupported", path=rest)
            return None
        # No recognized scheme: treat the whole string as an inline secret.
        log.warning("secret_bare_value", detail="bare secret value; use env:/vault: in prod")
        return ref
