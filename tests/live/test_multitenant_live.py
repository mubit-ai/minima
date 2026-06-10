"""Live multi-tenant e2e against a real Mubit instance — NO mocks.

Exercises the T3 structure end to end: provision an org (its Mubit key supplied only as a
server-side ``env:`` reference, never on the wire), authenticate with the Minima-issued
``mnim_…`` key, route /recommend + /feedback to that org's real Mubit instance, watch the
learning loop close in real memory, and prove the cross-org guard + auth rejections.

    cd ricedb && make run-mubit          # Mubit :3000 + embedder :8080
    MUBIT_ENDPOINT=http://127.0.0.1:3000 MUBIT_API_KEY=<admin> MUBIT_TRANSPORT=http \
        uv run pytest tests/live/test_multitenant_live.py -m live -s -q
"""

from __future__ import annotations

import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.llm.registry import build_reasoner
from minima.main import create_app
from minima.recommender.propensity import PropensityTracker
from minima.recommender.recstore import LaneCounter, RecommendationStore
from minima.tenancy.registry import InMemoryTenantStore
from minima.tenancy.runtime import TenantRuntime
from minima.tenancy.secrets import SecretResolver

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + a running Mubit"
    ),
]

PROV = "live-prov-secret"
TASK = "Summarize the following customer support email into one sentence."


def _settings() -> Settings:
    return Settings(
        minima_multitenant=True,
        minima_provisioning_key=PROV,
        mubit_api_key=None,  # multi-tenant: key comes from the per-org env: reference
        mubit_endpoint=os.environ["MUBIT_ENDPOINT"],
        mubit_transport=os.getenv("MUBIT_TRANSPORT", "http"),
        minima_memory_recall_timeout_ms=10_000,
        mubit_timeout_ms=30_000,
        minima_reflect_every_n=3,
    )


@pytest.fixture
def live_client():
    settings = _settings()
    runtime = TenantRuntime(
        settings=settings,
        catalog_store=CatalogStore(settings),
        reasoner=build_reasoner(settings),  # 'none' under the hermetic fixture
        recstore_backend=RecommendationStore(),
        propensity_backend=PropensityTracker(),
        lane_counter=LaneCounter(),
        tenant_store=InMemoryTenantStore(),
        secret_resolver=SecretResolver(),
    )  # NO memory_factory -> real MubitMemory per org
    app = create_app(settings=settings, tenant_runtime=runtime, start_refresh=False)
    with TestClient(app) as client:
        yield client


def _provision(client: TestClient, org: str, lane_prefix: str, endpoint: str | None = None) -> str:
    r = client.post(
        "/v1/admin/tenants",
        headers={"X-Minima-Provisioning-Key": PROV},
        json={
            "org_id": org,
            "mubit_endpoint": endpoint or os.environ["MUBIT_ENDPOINT"],
            # The org's real Mubit key is resolved server-side from this env reference;
            # it is never sent by the caller and never stored in the clear.
            "mubit_api_key_ref": "env:MUBIT_API_KEY",
            "mubit_transport": os.getenv("MUBIT_TRANSPORT", "http"),
            "lane_prefix": lane_prefix,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["minima_api_key"]


def _recommend(client: TestClient, key: str) -> dict:
    r = client.post(
        "/v1/recommend",
        headers={"Authorization": f"Bearer {key}"},
        json={"task": {"task": TASK, "task_type": "summarization"}, "allow_llm_escalation": False},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_multitenant_live_e2e(live_client: TestClient):
    run = uuid.uuid4().hex[:8]
    # Two logical orgs. Each carries its OWN Minima key -> its OWN Mubit instance. (Locally
    # there is one Mubit instance, so the two orgs use distinct lane_prefixes; the hard
    # instance boundary itself is Mubit-enforced — see verify_api_key — and would apply
    # automatically were these two separate instances.)
    acme_key = _provision(live_client, "acme", f"minima-acme-{run}")
    globex_key = _provision(live_client, "globex", f"minima-globex-{run}")

    # 1) Per-org health routes to the real instance.
    h = live_client.get("/v1/health", headers={"Authorization": f"Bearer {acme_key}"}).json()
    assert h["multitenant"] is True
    assert h["mubit"]["reachable"] is True, h
    assert h["mubit"]["org_id"] == "acme"
    print(f"\n[health] acme -> {h['mubit']['endpoint']} reachable={h['mubit']['reachable']}")

    # A unique-per-run task so OUR just-written outcome is the dominant recall neighbour —
    # makes the write->recall->reinforce loop deterministic even on a shared/dirty instance.
    uniq = f"Summarize support ticket {run}: customer {run} reports a billing error on invoice {run}."

    def rec_for(key: str, task: str) -> dict:
        r = live_client.post(
            "/v1/recommend",
            headers={"Authorization": f"Bearer {key}"},
            json={"task": {"task": task, "task_type": "summarization"}, "allow_llm_escalation": False},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def feedback(key: str, rec_id: str, model_id: str) -> dict:
        return live_client.post(
            "/v1/feedback",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": model_id,
                "outcome": "success",
                "quality_score": 0.95,
                "verified_in_production": True,
            },
        ).json()

    # 2) Recommend against real Mubit, then write a real outcome for the chosen model.
    r1 = rec_for(acme_key, uniq)
    rec_id = r1["recommendation_id"]
    chosen = r1["recommended_model"]["model_id"]
    assert "memory_unavailable" not in r1["warnings"], r1["warnings"]  # real recall ran
    print(f"[recommend] acme picks {chosen}  basis={r1['decision_basis']}")

    fb = feedback(acme_key, rec_id, chosen)
    assert fb["accepted"] is True, fb
    assert fb["record_id"], fb  # a real outcome record was written to Mubit
    print(f"[feedback] acme wrote outcome record_id={fb['record_id']}")

    # 3) The write is visible in real memory: re-recalling the same (unique) task returns our
    #    just-written outcome as evidence for `chosen`. Poll to absorb embedding/index lag.
    warm = r1
    ev = None
    polls = 0
    for _ in range(8):
        polls += 1
        time.sleep(1.5)
        warm = rec_for(acme_key, uniq)
        ev = next(
            (m for m in warm["ranked"] if m["model_id"] == chosen and m.get("evidence")), None
        )
        if ev:
            break
    assert ev is not None, f"{chosen} had no recalled evidence after feedback: {warm['warnings']}"
    print(f"[warm]   acme recalled own outcome for {chosen} in {polls} polls (evidence={len(ev['evidence'])})")

    # 3b) Reinforcement: feeding back on a recommendation whose chosen model now has recalled
    #     neighbours credits those exact Mubit entries (record_outcome reinforcement).
    fb2 = feedback(acme_key, warm["recommendation_id"], chosen)
    assert fb2["accepted"] is True, fb2
    assert fb2["reinforced_entry_ids"], fb2  # the recalled neighbours were credited
    print(f"[reinforce] acme reinforced {len(fb2['reinforced_entry_ids'])} recalled neighbour(s)")

    # 5) Cross-org guard (Minima-side): globex cannot resolve/credit acme's recommendation_id,
    #    regardless of the shared backing instance — the recstore is org-partitioned.
    cross = live_client.post(
        "/v1/feedback",
        headers={"Authorization": f"Bearer {globex_key}"},
        json={"recommendation_id": rec_id, "chosen_model_id": chosen, "outcome": "success"},
    ).json()
    assert cross["accepted"] is False
    assert "unknown_recommendation" in cross["warnings"]
    print(f"[isolation] globex denied acme's rec_id -> {cross['warnings']}")

    # 6) globex's recommend is independent (its own org-scoped recommendation_id). NOTE: it
    #    shares this single LOCAL Mubit instance with acme, and Mubit's lane is a soft filter
    #    under direct_bypass recall — so globex may see acme's memory here. In real T3 each org
    #    has its OWN instance, where that data is physically absent (the hard boundary).
    g = _recommend(live_client, globex_key)
    assert g["recommendation_id"] != rec_id
    print("[isolation] globex independent rec_id (own instance in prod = hard memory isolation)")

    # 6b) Per-org ROUTING proof: an org pointed at a DIFFERENT Mubit endpoint resolves to THAT
    #     instance — distinct orgs hit distinct instances. A deliberately-unreachable endpoint
    #     is reported unreachable for that org while acme's instance stays reachable.
    iso_key = _provision(
        live_client, "isolated", f"minima-iso-{run}", endpoint="http://127.0.0.1:3999"
    )
    hi = live_client.get("/v1/health", headers={"Authorization": f"Bearer {iso_key}"}).json()
    assert hi["mubit"]["endpoint"] == "http://127.0.0.1:3999"
    assert hi["mubit"]["reachable"] is False
    print(f"[routing] 'isolated' org -> {hi['mubit']['endpoint']} reachable=False")

    # 7) Auth: no key and a forged key are both rejected.
    body = {"task": {"task": TASK}, "allow_llm_escalation": False}
    assert live_client.post("/v1/recommend", json=body).status_code == 401
    forged = {"Authorization": "Bearer mnim_acme_0000_forgedsecret"}
    assert live_client.post("/v1/recommend", headers=forged, json=body).status_code == 401
    print("[auth]   missing/forged Minima key -> 401\n")
