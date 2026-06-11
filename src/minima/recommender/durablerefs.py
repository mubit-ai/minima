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
            DurableRef(model_id=str(m), entry_id=str(e), reference_id=str(r))
            for m, e, r in rows
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


def build_durable_refs(settings: Settings) -> DurableRefs:
    if settings.minima_recommendation_store.lower() == "sqlite":
        return SqliteDurableRefs(settings.minima_sqlite_path)
    return MemoryDurableRefs()
