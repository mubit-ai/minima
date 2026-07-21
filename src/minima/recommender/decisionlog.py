"""Per-recommendation decision log: the substrate for savings, calibration, and OPE.

Every recommendation is logged with its full candidate set, selection-propensity vector,
threshold, and counterfactual cost baselines; feedback reconciles the row with realized
outcome/cost/quality. /v1/savings, /v1/calibration, feedback-coverage, and offline policy
evaluation all read from here. Unlike the recstore (operational, TTL-bound), this log is
analytical and long-retention.

Backends mirror the recstore pattern: in-process default, SQLite for durability, an
org-scoped wrapper enforcing tenant isolation on every read.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from threading import Lock
from typing import Protocol, runtime_checkable

from minima.config import Settings
from minima.logging import get_logger
from minima.memory.records import TRUSTED_LABEL_SOURCES

log = get_logger("minima.decisionlog")

_SECONDS_PER_DAY = 86_400.0


@dataclass(slots=True)
class CandidateSnapshot:
    """One scored candidate at decision time, with its selection propensity."""

    model_id: str
    predicted_success: float
    confidence: float
    est_cost_usd: float
    propensity: float
    # Pre-calibration, pre-bonus Beta-posterior mean for the chosen candidate. Calibration
    # is fit on THIS (not the deployed predicted_success) so the loop converges. Defaults
    # to None for rows written before calibration existed (back-compat on deserialize).
    raw_predicted_success: float | None = None
    # Data-grounded predictable cost band at decision time; powers the cost-accuracy metric
    # (within-band coverage). None for rows written before bands existed, or thin evidence.
    est_cost_low: float | None = None
    est_cost_high: float | None = None


@dataclass(slots=True)
class DecisionRecord:
    recommendation_id: str
    org_id: str
    lane: str
    cluster: str
    task_type: str
    difficulty: str
    fingerprint: str
    ts: float  # wall-clock epoch seconds
    tau: float
    policy: str  # "thompson" | "argmin" (legacy rows may carry "epsilon_softmax")
    epsilon: float
    chosen_model_id: str
    escalated: bool
    # Legacy: what the (deleted) advisory shadow bandit would have picked. Kept only so
    # pre-existing persisted rows deserialize; never written since the Thompson default.
    shadow_chosen_model_id: str | None = None
    # True when the epsilon branch actually changed the pick away from the argmin
    # (distinct from policy == "epsilon_softmax", which only says exploration was POSSIBLE).
    explored: bool = False
    escalation_reasons: list[str] = field(default_factory=list)
    candidates: list[CandidateSnapshot] = field(default_factory=list)
    # Counterfactual baselines (same cost basis as the candidates, chosen once per set)
    est_cost_recommended: float = 0.0
    est_cost_premium: float = 0.0
    baseline_model_id: str | None = None
    est_cost_baseline_declared: float | None = None
    # Context needed by the late-feedback degraded path (recstore TTL expired)
    user_id: str | None = None
    env_tags: list[str] = field(default_factory=list)
    content: str = ""
    # Reconciliation columns — NULL until feedback arrives
    realized_model_id: str | None = None
    realized_outcome: str | None = None
    realized_quality: float | None = None
    realized_cost_usd: float | None = None
    realized_latency_ms: int | None = None
    feedback_ts: float | None = None
    late_feedback: bool = False
    # Provenance of the realized quality signal ("gate" | "judge" | "human" | "none").
    # None on rows reconciled before provenance existed — treated as untrusted by every
    # label consumer (calibration fit, ECE, CUSUM).
    evidence_source: str | None = None
    # Reasoning-effort tier the model actually ran at (client-reported) — the raw
    # material for learning (model x effort) arms.
    realized_effort: str | None = None
    # Classification provenance ("caller" | "heuristic" | "neighbor_vote") + the caller's
    # classifier confidence (TaskInput.task_type_confidence), so caller-labeled and
    # heuristic-labeled rows can be segmented later. None on rows written before these
    # existed (rows persist as JSON payloads — additive, no migration).
    task_type_source: str | None = None
    task_type_confidence: float | None = None
    # Recovery-ladder linkage: the immediately preceding rung's rec_id and the ladder
    # cause that triggered this re-route — the raw material for preference pairs and
    # learned escalation deferral. None outside recovery chains.
    parent_rec_id: str | None = None
    escalation_reason: str | None = None
    # Exact provider-reported model identifier (dated snapshot vs requested alias) —
    # the observable reset key for version-churn non-stationarity handling.
    provider_model_snapshot: str | None = None
    # P(this turn was selected for labeling); 1.0 for gate labels. NULL on legacy rows
    # and unlabeled turns — consumers must treat NULL as "uniform-era row".
    label_propensity: float | None = None
    # Shadow replay: what each challenger policy would have chosen at decision time
    # (policy name -> model_id). The raw material for replay-matched off-policy value
    # estimates. None on rows logged before challengers existed.
    shadow_choices: dict[str, str] | None = None

    @property
    def reconciled(self) -> bool:
        return self.realized_outcome is not None

    @property
    def predicted_success_chosen(self) -> float | None:
        for c in self.candidates:
            if c.model_id == self.chosen_model_id:
                return c.predicted_success
        return None

    @property
    def raw_predicted_success_chosen(self) -> float | None:
        """Pre-calibration Beta mean for the chosen model (the quantity calibration fits on).

        Falls back to the deployed ``predicted_success`` for rows logged before the raw
        value was captured, so historical rows still contribute (slightly biased) pairs.
        """
        for c in self.candidates:
            if c.model_id == self.chosen_model_id:
                if c.raw_predicted_success is not None:
                    return c.raw_predicted_success
                return c.predicted_success
        return None

    def _candidate(self, model_id: str | None) -> CandidateSnapshot | None:
        if not model_id:
            return None
        return next((c for c in self.candidates if c.model_id == model_id), None)

    @property
    def predicted_success_realized(self) -> float | None:
        """Prediction for the model that ACTUALLY ran (may differ from the pick).

        Pairing the recommended model's prediction with a divergent run's label
        corrupts calibration — the label belongs to whatever model produced it. None
        when the realized model wasn't in the scored candidate set (unpairable)."""
        c = self._candidate(self.realized_model_id or self.chosen_model_id)
        return c.predicted_success if c is not None else None

    @property
    def raw_predicted_success_realized(self) -> float | None:
        c = self._candidate(self.realized_model_id or self.chosen_model_id)
        if c is None:
            return None
        if c.raw_predicted_success is not None:
            return c.raw_predicted_success
        return c.predicted_success


@dataclass(slots=True)
class Reconciliation:
    """Realized-outcome fields applied to a decision row at feedback time."""

    model_id: str
    outcome: str
    # Strictly caller-supplied; None for unlabeled feedback. A label-based default is
    # never fabricated here. _apply stores it straight through to
    # DecisionRecord.realized_quality, which is likewise `float | None` (NULL).
    quality: float | None
    cost_usd: float | None = None
    latency_ms: int | None = None
    ts: float = 0.0
    late: bool = False
    evidence_source: str | None = None
    chosen_effort: str | None = None
    parent_rec_id: str | None = None
    escalation_reason: str | None = None
    provider_model_snapshot: str | None = None
    label_propensity: float | None = None


@runtime_checkable
class DecisionLog(Protocol):
    def put(self, rec: DecisionRecord) -> None: ...

    def get(self, recommendation_id: str) -> DecisionRecord | None: ...

    def reconcile(self, recommendation_id: str, update: Reconciliation) -> bool: ...

    def rows(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        lane: str | None = None,
    ) -> list[DecisionRecord]: ...


def _serialize(rec: DecisionRecord) -> str:
    data = asdict(rec)
    return json.dumps(data)


def _deserialize(payload: str) -> DecisionRecord:
    d = json.loads(payload)
    d["candidates"] = [CandidateSnapshot(**c) for c in d.get("candidates") or []]
    return DecisionRecord(**d)


def _apply(rec: DecisionRecord, update: Reconciliation) -> bool:
    """Apply realized fields; returns False for a replay (already reconciled with the
    same model — first write wins; a duplicate must not flip outcomes or costs). A
    different realized model is a divergence correction and is allowed through, and so
    is a TRUSTED label (gate/judge/human) landing on a row whose stored evidence is
    untrusted (None/"none") — telemetry first, the verdict later. Same-or-lower trust
    keeps first-write-wins; the first reconcile's cost/latency survive when the
    correction omits them. label_propensity travels with the label (a correction IS a
    new label event); the run-descriptive linkage fields stay first-write-wins."""
    if rec.reconciled and rec.realized_model_id == update.model_id:
        if (
            rec.evidence_source in TRUSTED_LABEL_SOURCES
            or update.evidence_source not in TRUSTED_LABEL_SOURCES
        ):
            return False
        rec.realized_outcome = update.outcome
        rec.realized_quality = update.quality
        if update.cost_usd is not None:
            rec.realized_cost_usd = update.cost_usd
        if update.latency_ms is not None:
            rec.realized_latency_ms = update.latency_ms
        rec.feedback_ts = update.ts or time.time()
        rec.late_feedback = update.late
        rec.evidence_source = update.evidence_source
        rec.label_propensity = update.label_propensity
        if update.chosen_effort is not None:
            rec.realized_effort = update.chosen_effort
        return True
    rec.realized_model_id = update.model_id
    rec.realized_outcome = update.outcome
    rec.realized_quality = update.quality
    rec.realized_cost_usd = update.cost_usd
    rec.realized_latency_ms = update.latency_ms
    rec.feedback_ts = update.ts or time.time()
    rec.late_feedback = update.late
    rec.evidence_source = update.evidence_source
    rec.realized_effort = update.chosen_effort
    rec.parent_rec_id = update.parent_rec_id
    rec.escalation_reason = update.escalation_reason
    rec.provider_model_snapshot = update.provider_model_snapshot
    rec.label_propensity = update.label_propensity
    return True


# Retention purge runs at most this often (the log is written on EVERY recommendation;
# purging on each write would put an O(n) scan / DELETE on the hot path).
_PURGE_INTERVAL_S = 300.0


class MemoryDecisionLog:
    """In-process decision log (lost on restart)."""

    def __init__(self, retention_days: int = 90):
        self._retention = retention_days * _SECONDS_PER_DAY
        self._data: dict[str, DecisionRecord] = {}
        self._lock = Lock()
        self._last_purge = 0.0

    def put(self, rec: DecisionRecord, org_id: str | None = None) -> None:
        if org_id is not None:
            rec.org_id = org_id
        if rec.ts == 0.0:
            rec.ts = time.time()
        with self._lock:
            if time.time() - self._last_purge > _PURGE_INTERVAL_S:
                self._purge_locked()
                self._last_purge = time.time()
            self._data[rec.recommendation_id] = rec

    def get(self, recommendation_id: str, org_id: str | None = None) -> DecisionRecord | None:
        with self._lock:
            rec = self._data.get(recommendation_id)
        if rec is None:
            return None
        if org_id is not None and rec.org_id != org_id:
            return None
        return rec

    def reconcile(
        self, recommendation_id: str, update: Reconciliation, org_id: str | None = None
    ) -> bool:
        with self._lock:
            rec = self._data.get(recommendation_id)
            if rec is None or (org_id is not None and rec.org_id != org_id):
                return False
            return _apply(rec, update)

    def rows(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        lane: str | None = None,
        org_id: str | None = None,
    ) -> list[DecisionRecord]:
        with self._lock:
            items = [
                r
                for r in self._data.values()
                if org_id is None or r.org_id == org_id
            ]
        out = []
        for rec in items:
            if since is not None and rec.ts < since:
                continue
            if until is not None and rec.ts > until:
                continue
            if lane is not None and rec.lane != lane:
                continue
            out.append(rec)
        out.sort(key=lambda r: r.ts)
        return out

    def _purge_locked(self) -> None:
        cutoff = time.time() - self._retention
        expired = [k for k, v in self._data.items() if v.ts and v.ts < cutoff]
        for k in expired:
            self._data.pop(k, None)


class SqliteDecisionLog:
    """Durable decision log backed by SQLite (stdlib; shares the recstore DB file)."""

    def __init__(self, path: str, retention_days: int = 90):
        self._retention = retention_days * _SECONDS_PER_DAY
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = Lock()
        self._last_purge = 0.0
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS decisions (
                    recommendation_id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL DEFAULT 'default',
                    ts REAL NOT NULL,
                    lane TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS ix_decisions_org_ts ON decisions(org_id, ts)"
            )

    def put(self, rec: DecisionRecord, org_id: str | None = None) -> None:
        if org_id is not None:
            rec.org_id = org_id
        if rec.ts == 0.0:
            rec.ts = time.time()
        with self._lock, self._conn:
            if time.time() - self._last_purge > _PURGE_INTERVAL_S:
                self._conn.execute(
                    "DELETE FROM decisions WHERE ts < ?", (time.time() - self._retention,)
                )
                self._last_purge = time.time()
            self._conn.execute(
                "INSERT OR REPLACE INTO decisions (recommendation_id, org_id, ts, lane, payload)"
                " VALUES (?, ?, ?, ?, ?)",
                (rec.recommendation_id, rec.org_id, rec.ts, rec.lane, _serialize(rec)),
            )

    def get(self, recommendation_id: str, org_id: str | None = None) -> DecisionRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT payload, org_id FROM decisions WHERE recommendation_id = ?",
                (recommendation_id,),
            ).fetchone()
        if row is None:
            return None
        if org_id is not None and str(row[1]) != org_id:
            return None
        return _deserialize(str(row[0]))

    def reconcile(
        self, recommendation_id: str, update: Reconciliation, org_id: str | None = None
    ) -> bool:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT payload, org_id FROM decisions WHERE recommendation_id = ?",
                (recommendation_id,),
            ).fetchone()
            if row is None or (org_id is not None and str(row[1]) != org_id):
                return False
            rec = _deserialize(str(row[0]))
            if not _apply(rec, update):
                return False
            self._conn.execute(
                "UPDATE decisions SET payload = ? WHERE recommendation_id = ?",
                (_serialize(rec), recommendation_id),
            )
            return True

    def rows(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        lane: str | None = None,
        org_id: str | None = None,
    ) -> list[DecisionRecord]:
        clauses: list[str] = []
        params: list[str | float] = []
        if org_id is not None:
            clauses.append("org_id = ?")
            params.append(org_id)
        if since is not None:
            clauses.append("ts >= ?")
            params.append(since)
        if until is not None:
            clauses.append("ts <= ?")
            params.append(until)
        if lane is not None:
            clauses.append("lane = ?")
            params.append(lane)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT payload FROM decisions {where} ORDER BY ts", params  # noqa: S608
            ).fetchall()
        return [_deserialize(str(r[0])) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class OrgScopedDecisionLog:
    """Binds a shared decision-log backend to one org (the tenant-isolation guard)."""

    def __init__(self, backend: DecisionLog, org_id: str):
        self._backend = backend
        self._org_id = org_id

    def put(self, rec: DecisionRecord) -> None:
        self._backend.put(rec, self._org_id)  # type: ignore[call-arg]

    def get(self, recommendation_id: str) -> DecisionRecord | None:
        return self._backend.get(recommendation_id, self._org_id)  # type: ignore[call-arg]

    def reconcile(self, recommendation_id: str, update: Reconciliation) -> bool:
        return self._backend.reconcile(recommendation_id, update, self._org_id)  # type: ignore[call-arg]

    def rows(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        lane: str | None = None,
    ) -> list[DecisionRecord]:
        return self._backend.rows(  # type: ignore[call-arg]
            since=since, until=until, lane=lane, org_id=self._org_id
        )


class PostgresDecisionLog:
    """Durable decision log backed by PostgreSQL (Cloud SQL via Auth Proxy).

    Shares the same database as the other Postgres stores; each store owns its table.
    """

    def __init__(self, database_url: str, retention_days: int = 90):
        from minima.recommender._pg_pool import cursor as _cursor

        self._retention = retention_days * _SECONDS_PER_DAY
        self._url = database_url
        self._cursor = _cursor
        self._last_purge = 0.0
        with self._cursor(self._url) as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS decisions (
                    recommendation_id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL DEFAULT 'default',
                    ts DOUBLE PRECISION NOT NULL,
                    lane TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS ix_decisions_org_ts ON decisions(org_id, ts)"
            )

    def put(self, rec: DecisionRecord, org_id: str | None = None) -> None:
        if org_id is not None:
            rec.org_id = org_id
        if rec.ts == 0.0:
            rec.ts = time.time()
        with self._cursor(self._url) as cur:
            if time.time() - self._last_purge > _PURGE_INTERVAL_S:
                cur.execute(
                    "DELETE FROM decisions WHERE ts < %s", (time.time() - self._retention,)
                )
                self._last_purge = time.time()
            cur.execute(
                """
                INSERT INTO decisions (recommendation_id, org_id, ts, lane, payload)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (recommendation_id) DO UPDATE SET
                    org_id  = EXCLUDED.org_id,
                    ts      = EXCLUDED.ts,
                    lane    = EXCLUDED.lane,
                    payload = EXCLUDED.payload
                """,
                (rec.recommendation_id, rec.org_id, rec.ts, rec.lane, _serialize(rec)),
            )

    def get(self, recommendation_id: str, org_id: str | None = None) -> DecisionRecord | None:
        with self._cursor(self._url) as cur:
            cur.execute(
                "SELECT payload, org_id FROM decisions WHERE recommendation_id = %s",
                (recommendation_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        if org_id is not None and str(row[1]) != org_id:
            return None
        return _deserialize(str(row[0]))

    def reconcile(
        self, recommendation_id: str, update: Reconciliation, org_id: str | None = None
    ) -> bool:
        with self._cursor(self._url) as cur:
            cur.execute(
                "SELECT payload, org_id FROM decisions WHERE recommendation_id = %s",
                (recommendation_id,),
            )
            row = cur.fetchone()
            if row is None or (org_id is not None and str(row[1]) != org_id):
                return False
            rec = _deserialize(str(row[0]))
            if not _apply(rec, update):
                return False
            cur.execute(
                "UPDATE decisions SET payload = %s WHERE recommendation_id = %s",
                (_serialize(rec), recommendation_id),
            )
        return True

    def rows(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        lane: str | None = None,
        org_id: str | None = None,
    ) -> list[DecisionRecord]:
        clauses: list[str] = []
        params: list[str | float] = []
        if org_id is not None:
            clauses.append("org_id = %s")
            params.append(org_id)
        if since is not None:
            clauses.append("ts >= %s")
            params.append(since)
        if until is not None:
            clauses.append("ts <= %s")
            params.append(until)
        if lane is not None:
            clauses.append("lane = %s")
            params.append(lane)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._cursor(self._url) as cur:
            cur.execute(
                f"SELECT payload FROM decisions {where} ORDER BY ts",  # noqa: S608
                params,
            )
            rows = cur.fetchall()
        return [_deserialize(str(r[0])) for r in rows]


def build_decision_log(settings: Settings) -> DecisionLog:
    retention = settings.minima_decision_log_retention_days
    backend = settings.minima_recommendation_store.strip().lower()
    if backend in ("cloudsql", "postgres", "postgresql"):
        if not settings.minima_database_url:
            raise RuntimeError(
                "MINIMA_DATABASE_URL is required when MINIMA_RECOMMENDATION_STORE=cloudsql"
            )
        return PostgresDecisionLog(settings.minima_database_url, retention)
    if backend == "sqlite":
        return SqliteDecisionLog(settings.minima_sqlite_path, retention)
    return MemoryDecisionLog(retention)
