"""Unit tests for pass-through tenancy: PassthroughRuntime and org-scoped state."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from minima.recommender.propensity import OrgScopedPropensity, PropensityTracker
from minima.recommender.recstore import (
    OrgScopedRecStore,
    RecommendationStore,
    StoredRecommendation,
)
from minima.tenancy.passthrough import PassthroughRuntime, _org_id


def _rec(rec_id: str = "r1") -> StoredRecommendation:
    return StoredRecommendation(
        recommendation_id=rec_id,
        lane="minima:default",
        user_id=None,
        task_type="qa",
        difficulty="easy",
        task_cluster="qa:easy",
        task_fingerprint="fp",
        content="c",
        env_tags=[],
        recommended_model_id="m1",
    )


# ---- org_id derivation ------------------------------------------------------


def test_org_id_parses_mbt_instance_tag():
    assert _org_id("mbt_myinstance_kid_secret") == "myinstance"


def test_org_id_falls_back_to_hash_for_unknown_format():
    result = _org_id("some-opaque-key")
    assert len(result) == 16
    assert result == _org_id("some-opaque-key")  # stable


def test_org_id_stable_across_calls():
    key = "mbt_acme_abc_xyz"
    assert _org_id(key) == _org_id(key)


# ---- PassthroughRuntime caching ---------------------------------------------


def _make_runtime():
    from minima.config import Settings
    from minima.recommender.propensity import build_propensity
    from minima.recommender.recstore import LaneCounter, build_recstore

    settings = Settings(mubit_api_key=None, minima_reasoner_provider="none")
    catalog_store = MagicMock()

    with patch("minima.tenancy.passthrough.MubitMemory"), \
         patch("minima.tenancy.passthrough.Recommender"):
        rt = PassthroughRuntime(
            settings=settings,
            catalog_store=catalog_store,
            reasoner=None,
            recstore_backend=build_recstore(settings),
            propensity_backend=build_propensity(settings),
            lane_counter=LaneCounter(),
        )
    return rt


def test_passthrough_same_key_returns_cached_context():
    rt = _make_runtime()
    with patch("minima.tenancy.passthrough.MubitMemory"), \
         patch("minima.tenancy.passthrough.Recommender"):
        ctx1 = rt.resolve("mbt_acme_k_s")
        ctx2 = rt.resolve("mbt_acme_k_s")
    assert ctx1 is ctx2


def test_passthrough_different_keys_return_different_contexts():
    rt = _make_runtime()
    with patch("minima.tenancy.passthrough.MubitMemory"), \
         patch("minima.tenancy.passthrough.Recommender"):
        ctx1 = rt.resolve("mbt_acme_k_s")
        ctx2 = rt.resolve("mbt_globex_k_s")
    assert ctx1 is not ctx2
    assert ctx1.org_id != ctx2.org_id


# ---- org-scoped state isolation --------------------------------------------


def test_org_scoped_recstore_isolates_by_org():
    backend = RecommendationStore()
    a = OrgScopedRecStore(backend, "acme")
    b = OrgScopedRecStore(backend, "globex")
    a.put(_rec("shared-id"))
    assert a.get("shared-id") is not None
    assert a.get("shared-id").org_id == "acme"  # type: ignore[union-attr]
    assert b.get("shared-id") is None


def test_org_scoped_propensity_isolates_by_org():
    backend = PropensityTracker()
    a = OrgScopedPropensity(backend, "acme")
    b = OrgScopedPropensity(backend, "globex")
    for _ in range(5):
        a.record("minima:default", "qa:easy", "m1")
    a_p = a.propensities("minima:default", "qa:easy", ["m1", "m2"])
    b_p = b.propensities("minima:default", "qa:easy", ["m1", "m2"])
    assert a_p["m1"] > a_p["m2"]
    assert b_p["m1"] == b_p["m2"]
