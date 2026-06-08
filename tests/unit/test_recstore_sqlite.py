from __future__ import annotations

from costit.config import Settings
from costit.recommender.propensity import (
    PropensityTracker,
    SqlitePropensityTracker,
    build_propensity,
)
from costit.recommender.recstore import (
    RecommendationStore,
    SqliteRecommendationStore,
    StoredRecommendation,
    build_recstore,
)


def _rec(rid: str = "r1") -> StoredRecommendation:
    return StoredRecommendation(
        recommendation_id=rid,
        lane="costit:default",
        user_id="u1",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        task_fingerprint="fp",
        content="[code/hard] do x",
        env_tags=["lang:python"],
        recommended_model_id="claude-haiku-4-5",
        neighbors_by_model={"claude-haiku-4-5": [("e1", "ref1"), ("e2", None)]},
    )


def test_sqlite_recstore_roundtrip_and_persistence(tmp_path):
    path = str(tmp_path / "rs.db")
    store = SqliteRecommendationStore(path, ttl_seconds=3600)
    store.put(_rec("r1"))

    got = store.get("r1")
    assert got is not None
    assert got.recommended_model_id == "claude-haiku-4-5"
    assert got.neighbors_by_model["claude-haiku-4-5"] == [("e1", "ref1"), ("e2", None)]
    assert got.env_tags == ["lang:python"]
    assert store.get("missing") is None

    # A fresh store on the same file still sees the record (durable across restarts).
    reopened = SqliteRecommendationStore(path, ttl_seconds=3600)
    assert reopened.get("r1") is not None


def test_sqlite_recstore_ttl_expiry(tmp_path):
    store = SqliteRecommendationStore(str(tmp_path / "rs.db"), ttl_seconds=0)
    store.put(_rec("r1"))
    assert store.get("r1") is None  # already older than a 0s ttl


def test_sqlite_propensity_roundtrip_and_persistence(tmp_path):
    path = str(tmp_path / "prop.db")
    p = SqlitePropensityTracker(path)
    for _ in range(3):
        p.record("costit:default", "code:hard", "claude-opus-4-8")
    p.record("costit:default", "code:hard", "gpt-4o-mini")

    shares = p.propensities("costit:default", "code:hard", ["claude-opus-4-8", "gpt-4o-mini"])
    # Laplace-smoothed: opus (3+1)/(4+2)=0.667, mini (1+1)/6=0.333.
    assert abs(shares["claude-opus-4-8"] - 4 / 6) < 1e-9
    assert abs(shares["gpt-4o-mini"] - 2 / 6) < 1e-9

    reopened = SqlitePropensityTracker(path)
    again = reopened.propensities("costit:default", "code:hard", ["claude-opus-4-8"])
    assert abs(again["claude-opus-4-8"] - (3 + 1) / (3 + 1)) < 1e-9  # only id -> (3+1)/(3+1)


def test_factories_select_backend(tmp_path):
    path = str(tmp_path / "x.db")
    mem = Settings(mubit_api_key="t", costit_recommendation_store="memory")
    sql = Settings(mubit_api_key="t", costit_recommendation_store="sqlite", costit_sqlite_path=path)
    assert isinstance(build_recstore(mem), RecommendationStore)
    assert isinstance(build_recstore(sql), SqliteRecommendationStore)
    assert isinstance(build_propensity(mem), PropensityTracker)
    assert isinstance(build_propensity(sql), SqlitePropensityTracker)
