"""Unit tests for the multi-tenancy primitives: keys, secrets, registry, org-scoping."""

from __future__ import annotations

import pytest

from minima.recommender.propensity import OrgScopedPropensity, PropensityTracker
from minima.recommender.recstore import (
    OrgScopedRecStore,
    RecommendationStore,
    StoredRecommendation,
)
from minima.tenancy.keys import (
    generate_minima_key,
    normalize_org_id,
    parse_minima_key,
    verify_secret,
)
from minima.tenancy.registry import InMemoryTenantStore, TenantRecord
from minima.tenancy.secrets import SecretResolver


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


# ---- keys -------------------------------------------------------------------


def test_minima_key_roundtrip_and_verify():
    key_id, secret_hash, full = generate_minima_key("acme")
    parsed = parse_minima_key(full)
    assert parsed is not None
    org, parsed_key_id, secret = parsed
    assert org == "acme"
    assert parsed_key_id == key_id
    assert verify_secret(secret, secret_hash)
    assert not verify_secret(secret + "x", secret_hash)


def test_minima_key_secret_may_contain_underscores():
    # token_urlsafe can include '_' / '-'; the secret is everything after the 3rd '_'.
    _kid, _h, full = generate_minima_key("globex")
    org, _key_id, secret = parse_minima_key(full)  # type: ignore[misc]
    assert org == "globex"
    assert full.endswith(secret)


@pytest.mark.parametrize("bad", ["", "nope", "mbt_x_y_z", "mnim_acme_only", "mnim__k_s"])
def test_parse_rejects_malformed(bad: str):
    assert parse_minima_key(bad) is None


@pytest.mark.parametrize("bad", ["", "-acme", "ACME!", "a" * 64])
def test_normalize_org_id_rejects_bad(bad: str):
    with pytest.raises(ValueError):
        normalize_org_id(bad)


def test_normalize_org_id_lowercases():
    assert normalize_org_id("Acme-1") == "acme-1"


# ---- secrets ----------------------------------------------------------------


def test_secret_resolver_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MUBIT_KEY_ACME", "mbt_secret")
    assert SecretResolver().resolve("env:MUBIT_KEY_ACME") == "mbt_secret"
    assert SecretResolver().resolve("env:MISSING_VAR") is None


def test_secret_resolver_inline_and_bare():
    r = SecretResolver()
    assert r.resolve("inline:abc") == "abc"
    assert r.resolve("barevalue") == "barevalue"
    assert r.resolve(None) is None
    assert r.resolve("  ") is None


# ---- registry ---------------------------------------------------------------


def test_inmemory_registry_crud():
    store = InMemoryTenantStore()
    rec = TenantRecord(
        org_id="acme",
        mubit_endpoint="http://acme:3000",
        mubit_api_key_ref="env:K",
        key_id="kid",
        secret_hash="h",
    )
    store.put(rec)
    assert store.get("acme") is rec
    assert [r.org_id for r in store.list()] == ["acme"]
    assert store.delete("acme") is True
    assert store.get("acme") is None
    assert store.delete("acme") is False


# ---- org-scoped state isolation --------------------------------------------


def test_org_scoped_recstore_isolates_by_org():
    backend = RecommendationStore()
    a = OrgScopedRecStore(backend, "acme")
    b = OrgScopedRecStore(backend, "globex")
    a.put(_rec("shared-id"))
    # acme can resolve its own recommendation; globex cannot (cross-org guard).
    assert a.get("shared-id") is not None
    assert a.get("shared-id").org_id == "acme"  # type: ignore[union-attr]
    assert b.get("shared-id") is None


def test_org_scoped_propensity_isolates_by_org():
    backend = PropensityTracker()
    a = OrgScopedPropensity(backend, "acme")
    b = OrgScopedPropensity(backend, "globex")
    for _ in range(5):
        a.record("minima:default", "qa:easy", "m1")
    # acme's recommendations skew its own propensity; globex is unaffected (uniform).
    a_p = a.propensities("minima:default", "qa:easy", ["m1", "m2"])
    b_p = b.propensities("minima:default", "qa:easy", ["m1", "m2"])
    assert a_p["m1"] > a_p["m2"]
    assert b_p["m1"] == b_p["m2"]
