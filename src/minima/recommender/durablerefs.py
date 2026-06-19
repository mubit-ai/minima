"""Bookkeeping for the durable (cluster, model) outcome records' Dereference ids.

Minima upserts exactly one durable outcome record per (lane, cluster, model) in Mubit
(``minima:om:{cluster}:{model_id}``). ANN recall usually surfaces it — but embedding
noise can push the single most-informative record out of the top-k. This store remembers
each durable record's stable entry id so the engine can Dereference it directly (exact
re-read) alongside recall, guaranteeing the highest-signal evidence is present.

Rows are written from two sources: feedback (the remember() record_id — upserts keep it
stable) and recall hits whose record matches the current cluster. Seeds are excluded
(they are per-row batch inserts, not the durable upsert).
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from threading import Lock
from typing import Protocol, runtime_checkable

from minima.config import Settings


@dataclass(slots=True)
class DurableRef:
    model_id: str
    entry_id: str
    reference_id: str


@runtime_checkable
class DurableRefs(Protocol):
    def upsert(
        self, lane: str, cluster: str, model_id: str, entry_id: str, reference_id: str
    ) -> None: ...

    def refs(self, lane: str, cluster: str, limit: int = 8) -> list[DurableRef]: ...


class MemoryDurableRefs:
    """In-process store (lost on restart — recall hits repopulate it organically)."""

    def __init__(self) -> None:
        self._data: dict[tuple[str, str, str], dict[str, DurableRef]] = {}
        self._lock = Lock()

    def upsert(
        self,
        lane: str,
        cluster: str,
        model_id: str,
        entry_id: str,
        reference_id: str,
        org_id: str = "default",
    ) -> None:
        if not entry_id and not reference_id:
            return
        with self._lock:
            bucket = self._data.setdefault((org_id, lane, cluster), {})
            bucket[model_id] = DurableRef(
                model_id=model_id, entry_id=entry_id, reference_id=reference_id or entry_id
            )

    def refs(
        self, lane: str, cluster: str, limit: int = 8, org_id: str = "default"
    ) -> list[DurableRef]:
        with self._lock:
            bucket = self._data.get((org_id, lane, cluster), {})
            return list(bucket.values())[: max(0, limit)]


class SqliteDurableRefs:
    """Durable store backed by SQLite (stdlib; shares the state DB file)."""

    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = Lock()
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS durable_refs (
                    org_id TEXT NOT NULL DEFAULT 'default',
                    lane TEXT NOT NULL,
                    cluster TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    entry_id TEXT NOT NULL,
                    reference_id TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_durable_refs "
                "ON durable_refs(org_id, lane, cluster, model_id)"
            )

    def upsert(
        self,
        lane: str,
        cluster: str,
        model_id: str,
        entry_id: str,
        reference_id: str,
        org_id: str = "default",
    ) -> None:
        if not entry_id and not reference_id:
            return
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO durable_refs
                    (org_id, lane, cluster, model_id, entry_id, reference_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(org_id, lane, cluster, model_id) DO UPDATE SET
                    entry_id = excluded.entry_id,
                    reference_id = excluded.reference_id,
                    updated_at = excluded.updated_at
                """,
                (
                    org_id,
                    lane,
                    cluster,
                    model_id,
                    entry_id,
                    reference_id or entry_id,
                    time.time(),
                ),
            )

    def refs(
        self, lane: str, cluster: str, limit: int = 8, org_id: str = "default"
    ) -> list[DurableRef]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT model_id, entry_id, reference_id FROM durable_refs "
                "WHERE org_id = ? AND lane = ? AND cluster = ? "
                "ORDER BY updated_at DESC LIMIT ?",
                (org_id, lane, cluster, max(0, limit)),
            ).fetchall()
        return [
            DurableRef(model_id=str(m), entry_id=str(e), reference_id=str(r)) for m, e, r in rows
        ]

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class OrgScopedDurableRefs:
    """Binds a shared backend to one org, presenting the ``DurableRefs`` Protocol."""

    def __init__(self, backend: DurableRefs, org_id: str):
        self._backend = backend
        self._org_id = org_id

    def upsert(
        self, lane: str, cluster: str, model_id: str, entry_id: str, reference_id: str
    ) -> None:
        self._backend.upsert(lane, cluster, model_id, entry_id, reference_id, self._org_id)  # type: ignore[call-arg]

    def refs(self, lane: str, cluster: str, limit: int = 8) -> list[DurableRef]:
        return self._backend.refs(lane, cluster, limit, self._org_id)  # type: ignore[call-arg]


class PostgresDurableRefs:
    """Durable refs store backed by PostgreSQL."""

    def __init__(self, database_url: str):
        from minima.recommender._pg_pool import cursor as _cursor

        self._url = database_url
        self._cursor = _cursor
        with self._cursor(self._url) as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS durable_refs (
                    org_id       TEXT             NOT NULL DEFAULT 'default',
                    lane         TEXT             NOT NULL,
                    cluster      TEXT             NOT NULL,
                    model_id     TEXT             NOT NULL,
                    entry_id     TEXT             NOT NULL,
                    reference_id TEXT             NOT NULL,
                    updated_at   DOUBLE PRECISION NOT NULL,
                    UNIQUE(org_id, lane, cluster, model_id)
                )
                """
            )

    def upsert(
        self,
        lane: str,
        cluster: str,
        model_id: str,
        entry_id: str,
        reference_id: str,
        org_id: str = "default",
    ) -> None:
        if not entry_id and not reference_id:
            return
        with self._cursor(self._url) as cur:
            cur.execute(
                """
                INSERT INTO durable_refs
                    (org_id, lane, cluster, model_id, entry_id, reference_id, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id, lane, cluster, model_id) DO UPDATE SET
                    entry_id     = EXCLUDED.entry_id,
                    reference_id = EXCLUDED.reference_id,
                    updated_at   = EXCLUDED.updated_at
                """,
                (
                    org_id,
                    lane,
                    cluster,
                    model_id,
                    entry_id,
                    reference_id or entry_id,
                    time.time(),
                ),
            )

    def refs(
        self, lane: str, cluster: str, limit: int = 8, org_id: str = "default"
    ) -> list[DurableRef]:
        with self._cursor(self._url) as cur:
            cur.execute(
                "SELECT model_id, entry_id, reference_id FROM durable_refs"
                " WHERE org_id = %s AND lane = %s AND cluster = %s"
                " ORDER BY updated_at DESC LIMIT %s",
                (org_id, lane, cluster, max(0, limit)),
            )
            rows = cur.fetchall()
        return [
            DurableRef(model_id=str(m), entry_id=str(e), reference_id=str(r)) for m, e, r in rows
        ]


class RedisDurableRefs:
    """Durable refs store backed by Redis (Cloud Memorystore).

    Each (org_id, lane, cluster) bucket is a Redis hash keyed by model_id, with
    the value being a JSON-encoded {entry_id, reference_id}. No TTL — refs are
    long-lived and updated in-place as new outcomes arrive.
    """

    def __init__(self, redis_url: str):
        from minima.recommender._redis_client import get_client

        self._r = get_client(redis_url)

    def _key(self, org_id: str, lane: str, cluster: str) -> str:
        return f"drefs:{org_id}:{lane}:{cluster}"

    def upsert(
        self,
        lane: str,
        cluster: str,
        model_id: str,
        entry_id: str,
        reference_id: str,
        org_id: str = "default",
    ) -> None:
        import json

        if not entry_id and not reference_id:
            return
        self._r.hset(
            self._key(org_id, lane, cluster),
            model_id,
            json.dumps({"entry_id": entry_id, "reference_id": reference_id or entry_id}),
        )

    def refs(
        self, lane: str, cluster: str, limit: int = 8, org_id: str = "default"
    ) -> list[DurableRef]:
        import json

        raw = self._r.hgetall(self._key(org_id, lane, cluster))
        from minima.recommender._redis_client import decode

        out: list[DurableRef] = []
        for model_id, value in raw.items():
            d = json.loads(value)
            out.append(
                DurableRef(
                    model_id=decode(model_id),
                    entry_id=d["entry_id"],
                    reference_id=d["reference_id"],
                )
            )
        return out[: max(0, limit)]


def build_durable_refs(settings: Settings) -> DurableRefs:
    backend = (
        settings.minima_recstore_backend.strip().lower()
        or settings.minima_recommendation_store.strip().lower()
    )
    if backend == "redis":
        if not settings.minima_redis_url:
            raise RuntimeError("MINIMA_REDIS_URL is required when MINIMA_RECSTORE_BACKEND=redis")
        return RedisDurableRefs(settings.minima_redis_url)
    if backend in ("cloudsql", "postgres", "postgresql"):
        if not settings.minima_database_url:
            raise RuntimeError(
                "MINIMA_DATABASE_URL is required when MINIMA_RECOMMENDATION_STORE=cloudsql"
            )
        return PostgresDurableRefs(settings.minima_database_url)
    if backend == "sqlite":
        return SqliteDurableRefs(settings.minima_sqlite_path)
    return MemoryDurableRefs()
