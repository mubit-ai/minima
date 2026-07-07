"""Store mapping a recommendation_id to the evidence that produced it.

Feedback resolves a recommendation_id here to know exactly which Mubit entries to
credit, without the caller having to round-trip the neighbor ids. The default backend
is in-process with a TTL; a SQLite backend persists recommendations across restarts so
feedback that arrives after a redeploy still credits the right neighbors.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Protocol, runtime_checkable

from minima.config import Settings
from minima.logging import get_logger

log = get_logger("minima.recstore")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Add ``column`` to ``table`` if a pre-existing (dev) DB predates it."""
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


@dataclass(slots=True)
class StoredRecommendation:
    recommendation_id: str
    lane: str
    user_id: str | None
    task_type: str
    difficulty: str
    task_cluster: str
    task_fingerprint: str
    content: str
    env_tags: list[str]
    recommended_model_id: str
    # model_id -> [(entry_id, reference_id), ...] recalled neighbors for that model
    neighbors_by_model: dict[str, list[tuple[str, str | None]]] = field(default_factory=dict)
    created_at: float = 0.0
    # Owning org (multi-tenancy). "default" in single-tenant mode. A get scoped to a
    # different org must NOT resolve this record — that is the cross-tenant guard on
    # /v1/feedback (org A can't credit/poison org B's recommendation_id).
    org_id: str = "default"


@runtime_checkable
class RecStore(Protocol):
    def put(self, rec: StoredRecommendation) -> None: ...

    def get(self, recommendation_id: str) -> StoredRecommendation | None: ...


class RecommendationStore:
    def __init__(self, ttl_seconds: int = 86_400):
        self._ttl = ttl_seconds
        self._data: dict[str, StoredRecommendation] = {}
        self._lock = Lock()

    def put(self, rec: StoredRecommendation) -> None:
        if rec.created_at == 0.0:
            rec.created_at = time.monotonic()
        with self._lock:
            self._purge_locked()
            self._data[rec.recommendation_id] = rec

    def get(self, recommendation_id: str, org_id: str | None = None) -> StoredRecommendation | None:
        with self._lock:
            rec = self._data.get(recommendation_id)
            if rec is None:
                return None
            if time.monotonic() - rec.created_at > self._ttl:
                self._data.pop(recommendation_id, None)
                return None
            if org_id is not None and rec.org_id != org_id:
                return None
            return rec

    def _purge_locked(self) -> None:
        now = time.monotonic()
        expired = [k for k, v in self._data.items() if now - v.created_at > self._ttl]
        for k in expired:
            self._data.pop(k, None)


def _serialize(rec: StoredRecommendation) -> str:
    return json.dumps(
        {
            "lane": rec.lane,
            "user_id": rec.user_id,
            "task_type": rec.task_type,
            "difficulty": rec.difficulty,
            "task_cluster": rec.task_cluster,
            "task_fingerprint": rec.task_fingerprint,
            "content": rec.content,
            "env_tags": rec.env_tags,
            "recommended_model_id": rec.recommended_model_id,
            "neighbors_by_model": {
                mid: [[eid, ref] for (eid, ref) in pairs]
                for mid, pairs in rec.neighbors_by_model.items()
            },
        }
    )


def _deserialize(
    rec_id: str, payload: str, created_at: float, org_id: str = "default"
) -> StoredRecommendation:
    d = json.loads(payload)
    return StoredRecommendation(
        recommendation_id=rec_id,
        lane=d["lane"],
        user_id=d.get("user_id"),
        task_type=d["task_type"],
        difficulty=d["difficulty"],
        task_cluster=d["task_cluster"],
        task_fingerprint=d["task_fingerprint"],
        content=d["content"],
        env_tags=list(d.get("env_tags") or []),
        recommended_model_id=d["recommended_model_id"],
        neighbors_by_model={
            mid: [(p[0], p[1]) for p in pairs]
            for mid, pairs in (d.get("neighbors_by_model") or {}).items()
        },
        created_at=created_at,
        org_id=org_id,
    )


class SqliteRecommendationStore:
    """Durable recommendation store backed by SQLite (stdlib; wall-clock TTL)."""

    def __init__(self, path: str, ttl_seconds: int = 86_400):
        self._ttl = ttl_seconds
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = Lock()
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS recommendations (
                    recommendation_id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    payload TEXT NOT NULL,
                    org_id TEXT NOT NULL DEFAULT 'default'
                )
                """
            )
            _ensure_column(
                self._conn, "recommendations", "org_id", "TEXT NOT NULL DEFAULT 'default'"
            )

    def put(self, rec: StoredRecommendation) -> None:
        # Durable TTL uses wall-clock epoch (monotonic is meaningless across restarts).
        created = time.time() if rec.created_at == 0.0 else rec.created_at
        with self._lock, self._conn:
            self._conn.execute(
                "DELETE FROM recommendations WHERE created_at < ?", (time.time() - self._ttl,)
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO recommendations "
                "(recommendation_id, created_at, payload, org_id) VALUES (?, ?, ?, ?)",
                (rec.recommendation_id, created, _serialize(rec), rec.org_id),
            )

    def get(self, recommendation_id: str, org_id: str | None = None) -> StoredRecommendation | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT created_at, payload, org_id FROM recommendations "
                "WHERE recommendation_id = ?",
                (recommendation_id,),
            ).fetchone()
        if row is None:
            return None
        created_at, payload, row_org = float(row[0]), str(row[1]), str(row[2])
        if time.time() - created_at > self._ttl:
            with self._lock, self._conn:
                self._conn.execute(
                    "DELETE FROM recommendations WHERE recommendation_id = ?", (recommendation_id,)
                )
            return None
        if org_id is not None and row_org != org_id:
            return None
        return _deserialize(recommendation_id, payload, created_at, row_org)

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class OrgScopedRecStore:
    """Binds a shared recstore backend to one org, presenting the ``RecStore`` Protocol.

    ``put`` stamps the org onto the record; ``get`` resolves only records owned by this
    org — so a feedback call authenticated as org A cannot resolve org B's
    recommendation_id. Used in both modes (single-tenant binds org ``"default"``).
    """

    def __init__(self, backend: RecStore, org_id: str):
        self._backend = backend
        self._org_id = org_id

    def put(self, rec: StoredRecommendation) -> None:
        rec.org_id = self._org_id
        self._backend.put(rec)

    def get(self, recommendation_id: str) -> StoredRecommendation | None:
        return self._backend.get(recommendation_id, self._org_id)  # type: ignore[call-arg]


class PostgresRecommendationStore:
    """Durable recommendation store backed by PostgreSQL (Cloud SQL via Auth Proxy)."""

    def __init__(self, database_url: str, ttl_seconds: int = 86_400):
        from minima.recommender._pg_pool import cursor as _cursor

        self._ttl = ttl_seconds
        self._url = database_url
        self._cursor = _cursor
        with self._cursor(self._url) as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS recommendations (
                    recommendation_id TEXT PRIMARY KEY,
                    created_at DOUBLE PRECISION NOT NULL,
                    payload TEXT NOT NULL,
                    org_id TEXT NOT NULL DEFAULT 'default'
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS ix_recs_created_at ON recommendations(created_at)"
            )

    def put(self, rec: StoredRecommendation) -> None:
        import time

        created = time.time() if rec.created_at == 0.0 else rec.created_at
        with self._cursor(self._url) as cur:
            cur.execute(
                "DELETE FROM recommendations WHERE created_at < %s", (time.time() - self._ttl,)
            )
            cur.execute(
                """
                INSERT INTO recommendations (recommendation_id, created_at, payload, org_id)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (recommendation_id) DO UPDATE SET
                    created_at = EXCLUDED.created_at,
                    payload    = EXCLUDED.payload,
                    org_id     = EXCLUDED.org_id
                """,
                (rec.recommendation_id, created, _serialize(rec), rec.org_id),
            )

    def get(self, recommendation_id: str, org_id: str | None = None) -> StoredRecommendation | None:
        import time

        with self._cursor(self._url) as cur:
            cur.execute(
                "SELECT created_at, payload, org_id FROM recommendations"
                " WHERE recommendation_id = %s",
                (recommendation_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        created_at, payload, row_org = float(row[0]), str(row[1]), str(row[2])
        if time.time() - created_at > self._ttl:
            with self._cursor(self._url) as cur:
                cur.execute(
                    "DELETE FROM recommendations WHERE recommendation_id = %s",
                    (recommendation_id,),
                )
            return None
        if org_id is not None and row_org != org_id:
            return None
        return _deserialize(recommendation_id, payload, created_at, row_org)


class RedisRecommendationStore:
    """Recommendation store backed by Redis (Cloud Memorystore).

    Each recommendation is stored as a Redis hash at key ``rec:{recommendation_id}``
    with a wall-clock TTL. Org isolation is enforced by checking the ``org_id`` field
    on every get.
    """

    def __init__(self, redis_url: str, ttl_seconds: int = 86_400):
        from minima.recommender._redis_client import get_client

        self._ttl = ttl_seconds
        self._r = get_client(redis_url)

    def _key(self, recommendation_id: str) -> str:
        return f"rec:{recommendation_id}"

    def put(self, rec: StoredRecommendation) -> None:
        import time

        created = time.time() if rec.created_at == 0.0 else rec.created_at
        key = self._key(rec.recommendation_id)
        self._r.hset(
            key,
            mapping={
                "payload": _serialize(rec),
                "created_at": str(created),
                "org_id": rec.org_id,
            },
        )
        self._r.expire(key, self._ttl)

    def get(self, recommendation_id: str, org_id: str | None = None) -> StoredRecommendation | None:
        import time

        key = self._key(recommendation_id)
        row = self._r.hgetall(key)
        if not row:
            return None
        created_at = float(row["created_at"])
        if time.time() - created_at > self._ttl:
            self._r.delete(key)
            return None
        row_org = row.get("org_id", "default")
        if org_id is not None and row_org != org_id:
            return None
        from minima.recommender._redis_client import decode

        return _deserialize(recommendation_id, decode(row["payload"]), created_at, decode(row_org))


def build_recstore(settings: Settings) -> RecStore:
    # MINIMA_RECSTORE_BACKEND overrides the backend for RecStore + DurableRefs only.
    # Falls back to MINIMA_RECOMMENDATION_STORE when not set.
    backend = (
        settings.minima_recstore_backend.strip().lower()
        or settings.minima_recommendation_store.strip().lower()
    )
    ttl = settings.minima_recommendation_ttl_seconds
    if backend == "redis":
        if not settings.minima_redis_url:
            raise RuntimeError("MINIMA_REDIS_URL is required when MINIMA_RECSTORE_BACKEND=redis")
        return RedisRecommendationStore(settings.minima_redis_url, ttl)
    if backend in ("cloudsql", "postgres", "postgresql"):
        if not settings.minima_database_url:
            raise RuntimeError(
                "MINIMA_DATABASE_URL is required when MINIMA_RECOMMENDATION_STORE=cloudsql"
            )
        return PostgresRecommendationStore(settings.minima_database_url, ttl)
    if backend == "sqlite":
        return SqliteRecommendationStore(settings.minima_sqlite_path, ttl)
    return RecommendationStore(ttl)


class LaneCounter:
    """Per-lane feedback counter used to trigger reflection on a cadence."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._lock = Lock()

    def bump(self, lane: str) -> int:
        with self._lock:
            self._counts[lane] = self._counts.get(lane, 0) + 1
            return self._counts[lane]
