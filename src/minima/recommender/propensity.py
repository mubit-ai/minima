"""Logging-propensity tracker for inverse-propensity-weighting bias correction.

Minima only observes outcomes for models it recommended, so frequently-recommended
models accumulate more evidence than rarely-tried ones. IPW re-weights each model's
recalled evidence by 1/propensity (clipped) so under-explored models aren't unfairly
buried. An in-process tracker is the default; a SQLite-backed tracker persists the
counts so the bias correction survives restarts.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from threading import Lock
from typing import Protocol, runtime_checkable

from minima.config import Settings


@runtime_checkable
class Propensity(Protocol):
    def record(self, lane: str, cluster: str, model_id: str) -> None: ...

    def propensities(self, lane: str, cluster: str, model_ids: Iterable[str]) -> dict[str, float]:
        ...


def _laplace_shares(bucket: dict[str, int], ids: list[str]) -> dict[str, float]:
    """Laplace-smoothed share of recommendations per model within a (lane, cluster)."""
    m = len(ids) or 1
    total = sum(bucket.get(mid, 0) for mid in ids)
    denom = total + m
    return {mid: (bucket.get(mid, 0) + 1) / denom for mid in ids}


class PropensityTracker:
    """In-process propensity counts (lost on restart)."""

    def __init__(self) -> None:
        self._counts: dict[tuple[str, str, str], dict[str, int]] = {}
        self._lock = Lock()

    def record(self, lane: str, cluster: str, model_id: str, org_id: str = "default") -> None:
        with self._lock:
            bucket = self._counts.setdefault((org_id, lane, cluster), {})
            bucket[model_id] = bucket.get(model_id, 0) + 1

    def propensities(
        self, lane: str, cluster: str, model_ids: Iterable[str], org_id: str = "default"
    ) -> dict[str, float]:
        ids = list(model_ids)
        with self._lock:
            bucket = dict(self._counts.get((org_id, lane, cluster), {}))
        return _laplace_shares(bucket, ids)


class SqlitePropensityTracker:
    """Durable propensity counts backed by SQLite (stdlib, no extra dependency)."""

    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = Lock()
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS propensity (
                    org_id TEXT NOT NULL DEFAULT 'default',
                    lane TEXT NOT NULL,
                    cluster TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            # Add org_id to a pre-existing (dev) DB that predates multi-tenancy.
            cols = {row[1] for row in self._conn.execute("PRAGMA table_info(propensity)")}
            if "org_id" not in cols:
                self._conn.execute(
                    "ALTER TABLE propensity ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'"
                )
            # Upsert target — works regardless of the original PRIMARY KEY shape.
            self._conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_propensity "
                "ON propensity(org_id, lane, cluster, model_id)"
            )

    def record(self, lane: str, cluster: str, model_id: str, org_id: str = "default") -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO propensity (org_id, lane, cluster, model_id, count)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(org_id, lane, cluster, model_id) DO UPDATE SET count = count + 1
                """,
                (org_id, lane, cluster, model_id),
            )

    def propensities(
        self, lane: str, cluster: str, model_ids: Iterable[str], org_id: str = "default"
    ) -> dict[str, float]:
        ids = list(model_ids)
        with self._lock:
            rows = self._conn.execute(
                "SELECT model_id, count FROM propensity "
                "WHERE org_id = ? AND lane = ? AND cluster = ?",
                (org_id, lane, cluster),
            ).fetchall()
        bucket = {str(mid): int(cnt) for mid, cnt in rows}
        return _laplace_shares(bucket, ids)

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class OrgScopedPropensity:
    """Binds a shared propensity backend to one org, presenting the ``Propensity`` Protocol."""

    def __init__(self, backend: Propensity, org_id: str):
        self._backend = backend
        self._org_id = org_id

    def record(self, lane: str, cluster: str, model_id: str) -> None:
        self._backend.record(lane, cluster, model_id, self._org_id)  # type: ignore[call-arg]

    def propensities(self, lane: str, cluster: str, model_ids: Iterable[str]) -> dict[str, float]:
        return self._backend.propensities(lane, cluster, model_ids, self._org_id)  # type: ignore[call-arg]


def build_propensity(settings: Settings) -> Propensity:
    if settings.minima_recommendation_store.lower() == "sqlite":
        return SqlitePropensityTracker(settings.minima_sqlite_path)
    return PropensityTracker()
