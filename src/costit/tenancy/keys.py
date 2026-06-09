"""Costit-issued API keys: ``cstk_<org>_<keyid>_<secret>``.

Mirrors Mubit's ``mbt_<instance>_<keyid>_<secret>`` shape so the org id is recoverable
from the key for routing, while authentication rests on a constant-time comparison of a
hash of the secret segment (the raw secret is never stored).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

PREFIX = "cstk"
# org ids are embedded in the key, so keep them to a url/path-safe alphabet.
_ORG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def normalize_org_id(org_id: str) -> str:
    org = org_id.strip().lower()
    if not _ORG_RE.match(org):
        raise ValueError(
            "org_id must be 1-63 chars of [a-z0-9-], starting alphanumeric (got "
            f"{org_id!r})"
        )
    return org


def hash_secret(secret: str) -> str:
    """Stable, non-reversible hash of a key's secret segment (stored, not the secret)."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def verify_secret(secret: str, secret_hash: str) -> bool:
    """Constant-time check of a presented secret against the stored hash."""
    return hmac.compare_digest(hash_secret(secret), secret_hash)


def generate_costit_key(org_id: str) -> tuple[str, str, str]:
    """Mint a key for an org. Returns ``(key_id, secret_hash, full_key)``.

    Only ``key_id`` and ``secret_hash`` are persisted; ``full_key`` is shown to the
    operator once and never recoverable afterwards.
    """
    org = normalize_org_id(org_id)
    key_id = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    full_key = f"{PREFIX}_{org}_{key_id}_{secret}"
    return key_id, hash_secret(secret), full_key


def parse_costit_key(key: str) -> tuple[str, str, str] | None:
    """Split a key into ``(org_id, key_id, secret)``; ``None`` if malformed.

    The secret may itself contain ``_`` (token_urlsafe), so split only the first three
    segments and keep the remainder as the secret.
    """
    if not key or not key.startswith(PREFIX + "_"):
        return None
    parts = key.split("_", 3)
    if len(parts) != 4:
        return None
    _prefix, org, key_id, secret = parts
    if not org or not key_id or not secret:
        return None
    try:
        org = normalize_org_id(org)
    except ValueError:
        return None
    return org, key_id, secret
