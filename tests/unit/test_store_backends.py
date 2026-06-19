"""Tests for PostgreSQL and Redis store backends.

Requires:
  - Local Postgres on port 55432 (mubit-synth-pg container)
  - Local Redis on port 6379 (mubit-local-redis container)

Run with:
  MINIMA_DATABASE_URL=... MINIMA_REDIS_URL=... uv run pytest tests/unit/test_store_backends.py -v

Or via the Makefile target:
  make test-backends
"""

from __future__ import annotations

import time
import uuid

import pytest

# ── connection strings ────────────────────────────────────────────────────────
PG_URL = "postgresql://minima_app:minima_local@localhost:55432/minima_test"
REDIS_URL = "redis://localhost:6379/1"  # DB 1 to avoid clobbering other local data

# ── helpers ───────────────────────────────────────────────────────────────────


def _uid() -> str:
    return str(uuid.uuid4())


def _rec(rid: str | None = None):
    from minima.recommender.recstore import StoredRecommendation

    return StoredRecommendation(
        recommendation_id=rid or _uid(),
        lane="minima:default",
        user_id="u1",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        task_fingerprint="fp123",
        content="[code/hard] write a sort",
        env_tags=["lang:python"],
        recommended_model_id="gemini-2.5-flash",
        neighbors_by_model={"gemini-2.5-flash": [("e1", "ref1"), ("e2", None)]},
    )


def _decision(rec_id: str | None = None, *, org_id: str = "default", lane: str = "minima:default"):
    from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord

    return DecisionRecord(
        recommendation_id=rec_id or _uid(),
        org_id=org_id,
        lane=lane,
        cluster="code:hard",
        task_type="code",
        difficulty="hard",
        fingerprint="f" * 40,
        ts=time.time(),
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id="gemini-2.5-flash",
        escalated=False,
        candidates=[
            CandidateSnapshot("gemini-2.5-flash", 0.85, 0.6, 0.001, 0.97),
            CandidateSnapshot("gemini-2.5-pro", 0.92, 0.7, 0.015, 0.03),
        ],
        est_cost_recommended=0.001,
        est_cost_premium=0.015,
    )


# ── PostgreSQL: RecStore ──────────────────────────────────────────────────────


class TestPostgresRecStore:
    @pytest.fixture(autouse=True)
    def store(self):
        from minima.recommender.recstore import PostgresRecommendationStore

        s = PostgresRecommendationStore(PG_URL, ttl_seconds=3600)
        yield s

    def test_put_get_roundtrip(self, store):
        rec = _rec()
        store.put(rec)
        got = store.get(rec.recommendation_id)
        assert got is not None
        assert got.recommended_model_id == "gemini-2.5-flash"
        assert got.neighbors_by_model["gemini-2.5-flash"] == [("e1", "ref1"), ("e2", None)]
        assert got.env_tags == ["lang:python"]

    def test_missing_returns_none(self, store):
        assert store.get("does-not-exist") is None

    def test_org_isolation(self, store):
        rec = _rec()
        rec.org_id = "org-a"
        store.put(rec)
        assert store.get(rec.recommendation_id, org_id="org-a") is not None
        assert store.get(rec.recommendation_id, org_id="org-b") is None

    def test_ttl_expiry(self):
        from minima.recommender.recstore import PostgresRecommendationStore

        store = PostgresRecommendationStore(PG_URL, ttl_seconds=0)
        rec = _rec()
        store.put(rec)
        assert store.get(rec.recommendation_id) is None

    def test_survives_reinstantiation(self):
        from minima.recommender.recstore import PostgresRecommendationStore

        rec = _rec()
        PostgresRecommendationStore(PG_URL, ttl_seconds=3600).put(rec)
        got = PostgresRecommendationStore(PG_URL, ttl_seconds=3600).get(rec.recommendation_id)
        assert got is not None
        assert got.recommendation_id == rec.recommendation_id


# ── PostgreSQL: DecisionLog ───────────────────────────────────────────────────


class TestPostgresDecisionLog:
    @pytest.fixture(autouse=True)
    def log(self):
        from minima.recommender.decisionlog import PostgresDecisionLog

        yield PostgresDecisionLog(PG_URL, retention_days=90)

    def test_put_get_roundtrip(self, log):
        d = _decision()
        log.put(d)
        got = log.get(d.recommendation_id)
        assert got is not None
        assert got.chosen_model_id == "gemini-2.5-flash"
        assert len(got.candidates) == 2
        assert not got.reconciled

    def test_reconcile(self, log):
        from minima.recommender.decisionlog import Reconciliation

        d = _decision()
        log.put(d)
        ok = log.reconcile(
            d.recommendation_id,
            Reconciliation(
                model_id="gemini-2.5-flash",
                outcome="success",
                quality=0.91,
                cost_usd=0.0009,
                latency_ms=312,
            ),
        )
        assert ok
        got = log.get(d.recommendation_id)
        assert got.reconciled
        assert got.realized_outcome == "success"
        assert got.realized_quality == pytest.approx(0.91)
        assert got.realized_latency_ms == 312

    def test_reconcile_missing_returns_false(self, log):
        from minima.recommender.decisionlog import Reconciliation

        assert not log.reconcile("nope", Reconciliation("m", "success", 0.9))

    def test_rows_time_window(self, log):
        now = time.time()
        d_old = _decision()
        d_old.ts = now - 1000
        d_new = _decision()
        d_new.ts = now - 10
        log.put(d_old)
        log.put(d_new)
        rows = log.rows(since=now - 100)
        ids = {r.recommendation_id for r in rows}
        assert d_new.recommendation_id in ids
        assert d_old.recommendation_id not in ids

    def test_rows_lane_filter(self, log):
        d1 = _decision(lane="minima:default")
        d2 = _decision(lane="minima:team-x")
        log.put(d1)
        log.put(d2)
        rows = log.rows(lane="minima:default")
        ids = {r.recommendation_id for r in rows}
        assert d1.recommendation_id in ids
        assert d2.recommendation_id not in ids

    def test_org_scoping(self, log):
        from minima.recommender.decisionlog import OrgScopedDecisionLog, Reconciliation

        org_a = OrgScopedDecisionLog(log, "org-a")
        org_b = OrgScopedDecisionLog(log, "org-b")
        d = _decision()
        org_a.put(d)
        assert org_a.get(d.recommendation_id) is not None
        assert org_b.get(d.recommendation_id) is None
        assert not org_b.reconcile(d.recommendation_id, Reconciliation("m", "success", 0.9))
        assert org_a.reconcile(d.recommendation_id, Reconciliation("m", "success", 0.9))

    def test_survives_reinstantiation(self):
        from minima.recommender.decisionlog import PostgresDecisionLog

        d = _decision()
        PostgresDecisionLog(PG_URL, retention_days=90).put(d)
        got = PostgresDecisionLog(PG_URL, retention_days=90).get(d.recommendation_id)
        assert got is not None


# ── PostgreSQL: PropensityTracker ─────────────────────────────────────────────


class TestPostgresPropensityTracker:
    @pytest.fixture(autouse=True)
    def tracker(self):
        from minima.recommender.propensity import PostgresPropensityTracker

        yield PostgresPropensityTracker(PG_URL)

    @pytest.fixture
    def cluster(self):
        """Unique cluster name per test so DB state from prior runs never bleeds in."""
        return _uid()

    def test_laplace_shares(self, tracker, cluster):
        for _ in range(3):
            tracker.record("minima:default", cluster, "gemini-2.5-flash")
        tracker.record("minima:default", cluster, "gemini-2.5-pro")
        shares = tracker.propensities(
            "minima:default", cluster, ["gemini-2.5-flash", "gemini-2.5-pro"]
        )
        # flash: (3+1)/(4+2)=4/6, pro: (1+1)/6=2/6
        assert abs(shares["gemini-2.5-flash"] - 4 / 6) < 1e-9
        assert abs(shares["gemini-2.5-pro"] - 2 / 6) < 1e-9

    def test_unseen_model_gets_laplace_prior(self, tracker, cluster):
        tracker.record("minima:default", cluster, "gemini-2.5-flash")
        shares = tracker.propensities(
            "minima:default", cluster, ["gemini-2.5-flash", "unseen-model"]
        )
        assert shares["unseen-model"] > 0

    def test_org_isolation(self, tracker):
        # Record flash 3× for org-a; org-b has no records.
        # With 2 models in the query: flash (org-a) → (3+1)/(3+2)=0.8; pro → 0.2.
        # org-b has no records → each model gets equal laplace prior (0.5 each).
        models = ["gemini-2.5-flash", "gemini-2.5-pro"]
        org_a_id = _uid()  # unique per test-run so prior runs don't accumulate
        for _ in range(3):
            tracker.record("minima:default", "code:hard:iso", "gemini-2.5-flash", org_id=org_a_id)
        shares_a = tracker.propensities("minima:default", "code:hard:iso", models, org_id=org_a_id)
        shares_b = tracker.propensities("minima:default", "code:hard:iso", models, org_id=_uid())
        # org-a flash > org-b flash (org-b has no history → equal laplace 0.5/0.5)
        assert shares_a["gemini-2.5-flash"] > shares_b["gemini-2.5-flash"]
        assert shares_a["gemini-2.5-pro"] < shares_b["gemini-2.5-pro"]

    def test_survives_reinstantiation(self):
        from minima.recommender.propensity import PostgresPropensityTracker

        lane, cluster, model = "minima:persist", "persist:test", _uid()
        PostgresPropensityTracker(PG_URL).record(lane, cluster, model)
        shares = PostgresPropensityTracker(PG_URL).propensities(lane, cluster, [model])
        # After 1 record: (1+1)/(1+1) = 1.0 (only model in set)
        assert shares[model] == pytest.approx(1.0)


# ── PostgreSQL: DurableRefs ───────────────────────────────────────────────────


class TestPostgresDurableRefs:
    @pytest.fixture(autouse=True)
    def refs(self):
        from minima.recommender.durablerefs import PostgresDurableRefs

        yield PostgresDurableRefs(PG_URL)

    def test_upsert_and_refs(self, refs):
        lane, cluster = "minima:default", _uid()
        refs.upsert(lane, cluster, "gemini-2.5-flash", "e1", "ref1")
        refs.upsert(lane, cluster, "gemini-2.5-pro", "e2", "ref2")
        result = refs.refs(lane, cluster)
        models = {r.model_id for r in result}
        assert models == {"gemini-2.5-flash", "gemini-2.5-pro"}

    def test_upsert_updates_in_place(self, refs):
        lane, cluster, model = "minima:default", _uid(), "gemini-2.5-flash"
        refs.upsert(lane, cluster, model, "e_old", "ref_old")
        refs.upsert(lane, cluster, model, "e_new", "ref_new")
        result = refs.refs(lane, cluster)
        assert len(result) == 1
        assert result[0].entry_id == "e_new"

    def test_limit(self, refs):
        lane, cluster = "minima:default", _uid()
        for i in range(5):
            refs.upsert(lane, cluster, f"model-{i}", f"e{i}", f"ref{i}")
        assert len(refs.refs(lane, cluster, limit=3)) == 3

    def test_empty_ids_skipped(self, refs):
        lane, cluster = "minima:default", _uid()
        refs.upsert(lane, cluster, "model-x", "", "")
        assert refs.refs(lane, cluster) == []

    def test_org_scoping(self, refs):
        from minima.recommender.durablerefs import OrgScopedDurableRefs

        lane, cluster = "minima:default", _uid()
        a = OrgScopedDurableRefs(refs, "org-a")
        b = OrgScopedDurableRefs(refs, "org-b")
        a.upsert(lane, cluster, "model-a", "ea", "ra")
        assert len(a.refs(lane, cluster)) == 1
        assert len(b.refs(lane, cluster)) == 0

    def test_survives_reinstantiation(self):
        from minima.recommender.durablerefs import PostgresDurableRefs

        lane, cluster, model = "minima:default", _uid(), "gemini-2.5-flash"
        PostgresDurableRefs(PG_URL).upsert(lane, cluster, model, "e1", "ref1")
        result = PostgresDurableRefs(PG_URL).refs(lane, cluster)
        assert any(r.model_id == model for r in result)


# ── Redis: RecStore ───────────────────────────────────────────────────────────


class TestRedisRecStore:
    @pytest.fixture(autouse=True)
    def store(self):
        from minima.recommender.recstore import RedisRecommendationStore

        yield RedisRecommendationStore(REDIS_URL, ttl_seconds=3600)

    def test_put_get_roundtrip(self, store):
        rec = _rec()
        store.put(rec)
        got = store.get(rec.recommendation_id)
        assert got is not None
        assert got.recommended_model_id == "gemini-2.5-flash"
        assert got.neighbors_by_model["gemini-2.5-flash"] == [("e1", "ref1"), ("e2", None)]

    def test_missing_returns_none(self, store):
        assert store.get("no-such-key") is None

    def test_org_isolation(self, store):
        rec = _rec()
        rec.org_id = "org-a"
        store.put(rec)
        assert store.get(rec.recommendation_id, org_id="org-a") is not None
        assert store.get(rec.recommendation_id, org_id="org-b") is None

    def test_ttl_expiry(self):
        from minima.recommender.recstore import RedisRecommendationStore

        store = RedisRecommendationStore(REDIS_URL, ttl_seconds=0)
        rec = _rec()
        store.put(rec)
        assert store.get(rec.recommendation_id) is None


# ── Redis: DurableRefs ────────────────────────────────────────────────────────


class TestRedisDurableRefs:
    @pytest.fixture(autouse=True)
    def refs(self):
        from minima.recommender.durablerefs import RedisDurableRefs

        yield RedisDurableRefs(REDIS_URL)

    def test_upsert_and_refs(self, refs):
        lane, cluster = "minima:default", _uid()
        refs.upsert(lane, cluster, "gemini-2.5-flash", "e1", "ref1")
        refs.upsert(lane, cluster, "gemini-2.5-pro", "e2", "ref2")
        result = refs.refs(lane, cluster)
        models = {r.model_id for r in result}
        assert models == {"gemini-2.5-flash", "gemini-2.5-pro"}

    def test_upsert_overwrites(self, refs):
        lane, cluster, model = "minima:default", _uid(), "gemini-2.5-flash"
        refs.upsert(lane, cluster, model, "e_old", "ref_old")
        refs.upsert(lane, cluster, model, "e_new", "ref_new")
        result = refs.refs(lane, cluster)
        assert len(result) == 1
        assert result[0].entry_id == "e_new"

    def test_limit(self, refs):
        lane, cluster = "minima:default", _uid()
        for i in range(6):
            refs.upsert(lane, cluster, f"model-{i}", f"e{i}", f"ref{i}")
        assert len(refs.refs(lane, cluster, limit=4)) == 4

    def test_empty_ids_skipped(self, refs):
        lane, cluster = "minima:default", _uid()
        refs.upsert(lane, cluster, "model-x", "", "")
        assert refs.refs(lane, cluster) == []

    def test_org_scoping(self, refs):
        from minima.recommender.durablerefs import OrgScopedDurableRefs

        lane, cluster = "minima:default", _uid()
        a = OrgScopedDurableRefs(refs, "org-a")
        b = OrgScopedDurableRefs(refs, "org-b")
        a.upsert(lane, cluster, "model-a", "ea", "ra")
        assert len(a.refs(lane, cluster)) == 1
        assert len(b.refs(lane, cluster)) == 0


# ── Factory wiring ────────────────────────────────────────────────────────────


def test_build_factories_select_correct_backend():
    from minima.config import Settings
    from minima.recommender.decisionlog import (
        MemoryDecisionLog,
        PostgresDecisionLog,
        build_decision_log,
    )
    from minima.recommender.durablerefs import (
        MemoryDurableRefs,
        PostgresDurableRefs,
        RedisDurableRefs,
        build_durable_refs,
    )
    from minima.recommender.propensity import (
        PostgresPropensityTracker,
        PropensityTracker,
        build_propensity,
    )
    from minima.recommender.recstore import (
        PostgresRecommendationStore,
        RecommendationStore,
        RedisRecommendationStore,
        build_recstore,
    )

    mem = Settings(mubit_api_key="t", minima_recommendation_store="memory")
    assert isinstance(build_recstore(mem), RecommendationStore)
    assert isinstance(build_decision_log(mem), MemoryDecisionLog)
    assert isinstance(build_propensity(mem), PropensityTracker)
    assert isinstance(build_durable_refs(mem), MemoryDurableRefs)

    pg = Settings(
        mubit_api_key="t",
        minima_recommendation_store="cloudsql",
        minima_database_url=PG_URL,
    )
    assert isinstance(build_recstore(pg), PostgresRecommendationStore)
    assert isinstance(build_decision_log(pg), PostgresDecisionLog)
    assert isinstance(build_propensity(pg), PostgresPropensityTracker)
    assert isinstance(build_durable_refs(pg), PostgresDurableRefs)

    # Hybrid: cloud SQL for analytical, redis for operational
    hybrid = Settings(
        mubit_api_key="t",
        minima_recommendation_store="cloudsql",
        minima_database_url=PG_URL,
        minima_recstore_backend="redis",
        minima_redis_url=REDIS_URL,
    )
    assert isinstance(build_recstore(hybrid), RedisRecommendationStore)
    # decision log follows RECOMMENDATION_STORE; durable refs follow RECSTORE_BACKEND below
    assert isinstance(build_decision_log(hybrid), PostgresDecisionLog)
    assert isinstance(build_propensity(hybrid), PostgresPropensityTracker)
    assert isinstance(build_durable_refs(hybrid), RedisDurableRefs)


def test_cloudsql_without_url_raises():
    from minima.config import Settings
    from minima.recommender.decisionlog import build_decision_log
    from minima.recommender.recstore import build_recstore

    s = Settings(mubit_api_key="t", minima_recommendation_store="cloudsql")
    with pytest.raises(RuntimeError, match="MINIMA_DATABASE_URL"):
        build_recstore(s)
    with pytest.raises(RuntimeError, match="MINIMA_DATABASE_URL"):
        build_decision_log(s)


def test_redis_without_url_raises():
    from minima.config import Settings
    from minima.recommender.recstore import build_recstore

    s = Settings(
        mubit_api_key="t",
        minima_recommendation_store="cloudsql",
        minima_database_url=PG_URL,
        minima_recstore_backend="redis",
        minima_redis_url="",
    )
    with pytest.raises(RuntimeError, match="MINIMA_REDIS_URL"):
        build_recstore(s)
