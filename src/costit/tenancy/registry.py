"""The tenant registry: org_id -> (Mubit instance + secret reference + Costit key hash).

This is the only place a Costit key maps to an org's Mubit instance. The org's Mubit
key is stored as a *reference* (resolved by ``SecretResolver``), and only a hash of the
Costit key's secret is stored — so neither secret is recoverable from the registry.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from threading import Lock
from typing import Protocol, runtime_checkable

from costit.config import Settings
from costit.logging import get_logger

log = get_logger("costit.tenancy.registry")


@dataclass(slots=True)
class TenantRecord:
    org_id: str
    mubit_endpoint: str
    # Reference resolved by SecretResolver (env:NAME / inline:VALUE / vault:path).
    mubit_api_key_ref: str
    key_id: str
    secret_hash: str
    mubit_transport: str = "http"
    lane_prefix: str = "costit"
    reads_shared_seed: bool = False
    created_at: float = 0.0


@runtime_checkable
class TenantStore(Protocol):
    def get(self, org_id: str) -> TenantRecord | None: ...

    def put(self, record: TenantRecord) -> None: ...

    def delete(self, org_id: str) -> bool: ...

    def list(self) -> list[TenantRecord]: ...


def _record_from_dict(d: dict) -> TenantRecord:
    return TenantRecord(
        org_id=str(d["org_id"]),
        mubit_endpoint=str(d["mubit_endpoint"]),
        mubit_api_key_ref=str(d["mubit_api_key_ref"]),
        key_id=str(d.get("key_id", "")),
        secret_hash=str(d.get("secret_hash", "")),
        mubit_transport=str(d.get("mubit_transport", "http")),
        lane_prefix=str(d.get("lane_prefix", "costit")),
        reads_shared_seed=bool(d.get("reads_shared_seed", False)),
        created_at=float(d.get("created_at", 0.0)),
    )


class InMemoryTenantStore:
    """Process-local registry, optionally seeded from a bootstrap JSON file (dev)."""

    def __init__(self, bootstrap_file: str | None = None):
        self._data: dict[str, TenantRecord] = {}
        self._lock = Lock()
        if bootstrap_file:
            self._load_bootstrap(bootstrap_file)

    def _load_bootstrap(self, path: str) -> None:
        try:
            with open(path, encoding="utf-8") as fh:
                rows = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("tenant_bootstrap_failed", path=path, error=str(exc))
            return
        for row in rows if isinstance(rows, list) else []:
            try:
                rec = _record_from_dict(row)
            except (KeyError, ValueError) as exc:
                log.warning("tenant_bootstrap_row_skipped", error=str(exc))
                continue
            self._data[rec.org_id] = rec
        log.info("tenant_bootstrap_loaded", count=len(self._data), path=path)

    def get(self, org_id: str) -> TenantRecord | None:
        with self._lock:
            return self._data.get(org_id)

    def put(self, record: TenantRecord) -> None:
        with self._lock:
            self._data[record.org_id] = record

    def delete(self, org_id: str) -> bool:
        with self._lock:
            return self._data.pop(org_id, None) is not None

    def list(self) -> list[TenantRecord]:
        with self._lock:
            return list(self._data.values())


class SqliteTenantStore:
    """Durable registry backed by SQLite (stdlib)."""

    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = Lock()
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tenants (
                    org_id TEXT PRIMARY KEY,
                    mubit_endpoint TEXT NOT NULL,
                    mubit_api_key_ref TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    secret_hash TEXT NOT NULL,
                    mubit_transport TEXT NOT NULL DEFAULT 'http',
                    lane_prefix TEXT NOT NULL DEFAULT 'costit',
                    reads_shared_seed INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL DEFAULT 0
                )
                """
            )

    def get(self, org_id: str) -> TenantRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM tenants WHERE org_id = ?", (org_id,)
            ).fetchone()
        return self._row(row) if row else None

    def put(self, record: TenantRecord) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO tenants
                (org_id, mubit_endpoint, mubit_api_key_ref, key_id, secret_hash,
                 mubit_transport, lane_prefix, reads_shared_seed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.org_id,
                    record.mubit_endpoint,
                    record.mubit_api_key_ref,
                    record.key_id,
                    record.secret_hash,
                    record.mubit_transport,
                    record.lane_prefix,
                    int(record.reads_shared_seed),
                    record.created_at,
                ),
            )

    def delete(self, org_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM tenants WHERE org_id = ?", (org_id,))
        return cur.rowcount > 0

    def list(self) -> list[TenantRecord]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM tenants").fetchall()
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(row: Iterable) -> TenantRecord:
        (
            org_id,
            endpoint,
            key_ref,
            key_id,
            secret_hash,
            transport,
            lane_prefix,
            reads_shared_seed,
            created_at,
        ) = row
        return TenantRecord(
            org_id=str(org_id),
            mubit_endpoint=str(endpoint),
            mubit_api_key_ref=str(key_ref),
            key_id=str(key_id),
            secret_hash=str(secret_hash),
            mubit_transport=str(transport),
            lane_prefix=str(lane_prefix),
            reads_shared_seed=bool(reads_shared_seed),
            created_at=float(created_at),
        )

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def build_tenant_store(settings: Settings) -> TenantStore:
    if settings.costit_tenant_store.lower() == "sqlite":
        return SqliteTenantStore(settings.costit_tenant_store_path)
    return InMemoryTenantStore(settings.costit_tenant_bootstrap_file)
