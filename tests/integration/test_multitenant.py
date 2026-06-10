"""API-level multi-tenancy: provisioning, per-org routing, and cross-org isolation.

Uses a per-org FakeMemory (injected via the runtime's memory_factory) so the full
request path is exercised without a live Mubit — the live e2e is separate.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.main import create_app
from minima.memory.adapter import Memory
from minima.recommender.propensity import PropensityTracker
from minima.recommender.recstore import LaneCounter, RecommendationStore
from minima.tenancy.registry import InMemoryTenantStore
from minima.tenancy.runtime import TenantRuntime
from minima.tenancy.secrets import SecretResolver
from tests.factories import FakeMemory


@pytest.fixture
def fakes() -> dict[str, FakeMemory]:
    return {}


@pytest.fixture
def mt_client(fakes: dict[str, FakeMemory]):
    settings = Settings(
        minima_multitenant=True,
        minima_provisioning_key="prov-secret",
        mubit_api_key=None,
        minima_reflect_every_n=3,
        minima_reasoner_provider="none",
    )

    def factory(endpoint: str, _api_key: str | None, _transport: str) -> Memory:
        return fakes.setdefault(endpoint, FakeMemory())

    runtime = TenantRuntime(
        settings=settings,
        catalog_store=CatalogStore(settings),
        reasoner=None,
        recstore_backend=RecommendationStore(),
        propensity_backend=PropensityTracker(),
        lane_counter=LaneCounter(),
        tenant_store=InMemoryTenantStore(),
        secret_resolver=SecretResolver(),
        memory_factory=factory,
    )
    app = create_app(settings=settings, tenant_runtime=runtime, start_refresh=False)
    with TestClient(app) as client:
        yield client


def _provision(client: TestClient, org: str, endpoint: str) -> str:
    r = client.post(
        "/v1/admin/tenants",
        headers={"X-Minima-Provisioning-Key": "prov-secret"},
        json={"org_id": org, "mubit_endpoint": endpoint, "mubit_api_key_ref": f"inline:k-{org}"},
    )
    assert r.status_code == 201, r.text
    return r.json()["minima_api_key"]


def test_provisioning_requires_key(mt_client: TestClient):
    # No provisioning key -> 403.
    r = mt_client.post(
        "/v1/admin/tenants",
        json={"org_id": "acme", "mubit_endpoint": "http://acme", "mubit_api_key_ref": "inline:k"},
    )
    assert r.status_code == 403
    # Wrong provisioning key -> 403.
    r = mt_client.post(
        "/v1/admin/tenants",
        headers={"X-Minima-Provisioning-Key": "wrong"},
        json={"org_id": "acme", "mubit_endpoint": "http://acme", "mubit_api_key_ref": "inline:k"},
    )
    assert r.status_code == 403


def test_recommend_requires_valid_minima_key(mt_client: TestClient):
    body = {"task": {"task": "Summarize this paragraph."}, "allow_llm_escalation": False}
    assert mt_client.post("/v1/recommend", json=body).status_code == 401
    bad = {"Authorization": "Bearer mnim_acme_dead_beef"}
    assert mt_client.post("/v1/recommend", headers=bad, json=body).status_code == 401


def test_per_org_routing_and_cross_org_isolation(
    mt_client: TestClient, fakes: dict[str, FakeMemory]
):
    acme_key = _provision(mt_client, "acme", "http://acme")
    globex_key = _provision(mt_client, "globex", "http://globex")

    # Re-keying an existing org is refused (delete first).
    dup = mt_client.post(
        "/v1/admin/tenants",
        headers={"X-Minima-Provisioning-Key": "prov-secret"},
        json={"org_id": "acme", "mubit_endpoint": "http://acme", "mubit_api_key_ref": "inline:x"},
    )
    assert dup.status_code == 409

    body = {"task": {"task": "Summarize this paragraph."}, "allow_llm_escalation": False}
    r = mt_client.post(
        "/v1/recommend", headers={"Authorization": f"Bearer {acme_key}"}, json=body
    )
    assert r.status_code == 200, r.text
    rec_id = r.json()["recommendation_id"]
    chosen = r.json()["recommended_model"]["model_id"]

    fb = {"recommendation_id": rec_id, "chosen_model_id": chosen, "outcome": "success"}

    # globex cannot resolve acme's recommendation_id -> cross-org guard.
    r_cross = mt_client.post(
        "/v1/feedback", headers={"Authorization": f"Bearer {globex_key}"}, json=fb
    )
    assert r_cross.status_code == 200
    assert r_cross.json()["accepted"] is False
    assert "unknown_recommendation" in r_cross.json()["warnings"]

    # acme can, and the write lands in acme's instance, not globex's.
    r_own = mt_client.post(
        "/v1/feedback", headers={"Authorization": f"Bearer {acme_key}"}, json=fb
    )
    assert r_own.status_code == 200
    assert r_own.json()["accepted"] is True
    assert fakes["http://acme"].remembered, "acme's instance should have received the outcome"
    assert not fakes["http://globex"].remembered, "globex's instance must be untouched"


def test_admin_list_and_delete(mt_client: TestClient):
    _provision(mt_client, "acme", "http://acme")
    prov = {"X-Minima-Provisioning-Key": "prov-secret"}
    listed = mt_client.get("/v1/admin/tenants", headers=prov).json()
    assert listed["count"] == 1
    assert listed["tenants"][0]["org_id"] == "acme"
    # No secret material leaks in the listing.
    assert "secret_hash" not in listed["tenants"][0]
    assert "mubit_api_key_ref" not in listed["tenants"][0]

    d = mt_client.delete("/v1/admin/tenants/acme", headers=prov)
    assert d.status_code == 200 and d.json()["deleted"] is True
    assert mt_client.get("/v1/admin/tenants", headers=prov).json()["count"] == 0
