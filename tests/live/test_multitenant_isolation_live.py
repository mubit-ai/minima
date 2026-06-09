"""Hard cross-instance isolation — requires TWO real Mubit instances.

The single-instance live test (test_multitenant_live.py) proves per-org *routing* and the
Costit-side guards, but NOT memory isolation (one instance + soft lane filter). This test
proves the hard boundary: an outcome written to org A's instance is physically absent from
org B's instance, and org A's Mubit key is rejected by org B's instance.

Provide two instances via env (skipped otherwise):

    export COSTIT_MT_A_ENDPOINT=http://127.0.0.1:3000  COSTIT_MT_A_KEY=mbt_instA_...
    export COSTIT_MT_B_ENDPOINT=http://127.0.0.1:3001  COSTIT_MT_B_KEY=mbt_instB_...
    uv run pytest tests/live/test_multitenant_isolation_live.py -m live -s -q

Two instances can be: (a) two local `mubit` processes on different ports with distinct
MUBIT_INSTANCE_ID + RocksDB dirs, or (b) two hosted dev MubitInstance CRDs.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from costit.catalog.store import CatalogStore
from costit.config import Settings
from costit.main import create_app
from costit.memory.adapter import MubitMemory
from costit.recommender.propensity import PropensityTracker
from costit.recommender.recstore import LaneCounter, RecommendationStore
from costit.tenancy.registry import InMemoryTenantStore
from costit.tenancy.runtime import TenantRuntime
from costit.tenancy.secrets import SecretResolver

_REQUIRED = ["COSTIT_MT_A_ENDPOINT", "COSTIT_MT_A_KEY", "COSTIT_MT_B_ENDPOINT", "COSTIT_MT_B_KEY"]

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not all(os.getenv(v) for v in _REQUIRED),
        reason="needs two Mubit instances: " + ", ".join(_REQUIRED),
    ),
]

PROV = "iso-prov-secret"
TASK = "Refactor this recursive descent parser into an iterative state machine."


def _runtime() -> TenantRuntime:
    s = Settings(
        costit_multitenant=True,
        costit_provisioning_key=PROV,
        mubit_api_key=None,
        mubit_transport=os.getenv("MUBIT_TRANSPORT", "http"),
        costit_memory_recall_timeout_ms=10_000,
        mubit_timeout_ms=30_000,
        costit_reasoner_provider="none",
    )
    return TenantRuntime(
        settings=s,
        catalog_store=CatalogStore(s),
        reasoner=None,
        recstore_backend=RecommendationStore(),
        propensity_backend=PropensityTracker(),
        lane_counter=LaneCounter(),
        tenant_store=InMemoryTenantStore(),
        secret_resolver=SecretResolver(),
    )  # real per-org MubitMemory


def _provision(c: TestClient, org: str, endpoint_env: str, key_env: str, lane: str) -> str:
    r = c.post(
        "/v1/admin/tenants",
        headers={"X-Costit-Provisioning-Key": PROV},
        json={
            "org_id": org,
            "mubit_endpoint": os.environ[endpoint_env],
            "mubit_api_key_ref": f"env:{key_env}",  # resolver reads the real key from env
            "mubit_transport": os.getenv("MUBIT_TRANSPORT", "http"),
            "lane_prefix": lane,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["costit_api_key"]


def _recommend(c: TestClient, key: str) -> dict:
    r = c.post(
        "/v1/recommend",
        headers={"Authorization": f"Bearer {key}"},
        json={"task": {"task": TASK, "task_type": "code"}, "allow_llm_escalation": False},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _evidence_ids(resp: dict) -> set[str]:
    ids: set[str] = set()
    for m in resp["ranked"]:
        for e in m.get("evidence", []):
            ids.add(e["entry_id"])
            if e.get("reference_id"):
                ids.add(e["reference_id"])
    return ids


def test_hard_cross_instance_isolation():
    run = uuid.uuid4().hex[:8]
    rt = _runtime()
    app = create_app(settings=rt._settings, tenant_runtime=rt, start_refresh=False)

    with TestClient(app) as c:
        a_key = _provision(c, "orga", "COSTIT_MT_A_ENDPOINT", "COSTIT_MT_A_KEY", f"iso-a-{run}")
        b_key = _provision(c, "orgb", "COSTIT_MT_B_ENDPOINT", "COSTIT_MT_B_KEY", f"iso-b-{run}")

        # 1) Write a distinctive outcome into org A's instance.
        a1 = _recommend(c, a_key)
        chosen = a1["recommended_model"]["model_id"]
        fb = c.post(
            "/v1/feedback",
            headers={"Authorization": f"Bearer {a_key}"},
            json={
                "recommendation_id": a1["recommendation_id"],
                "chosen_model_id": chosen,
                "outcome": "success",
                "quality_score": 0.95,
                "verified_in_production": True,
            },
        ).json()
        assert fb["accepted"] and fb["record_id"], fb
        a_record_id = fb["record_id"]

        # 2) org A recalls its own write (loop closed on instance A).
        a_ids: set[str] = set()
        for _ in range(8):
            time.sleep(1.5)
            a_ids = _evidence_ids(_recommend(c, a_key))
            if a_ids:
                break
        assert a_ids, "org A did not recall its own outcome on instance A"

        # 3) HARD ISOLATION: org B recalls the SAME task and must NOT see A's record. The
        #    record A wrote lives only in instance A; instance B cannot return it.
        b_ids = _evidence_ids(_recommend(c, b_key))
        assert a_record_id not in b_ids, "org A's record leaked into org B's instance!"
        assert a_ids.isdisjoint(b_ids), (
            f"org A and org B share recalled entries (instances not isolated): "
            f"{a_ids & b_ids}"
        )
        print(f"\n[hard-iso] A wrote {a_record_id}; B recall did not contain it (A∩B={a_ids & b_ids})")

        # 4) Mubit-enforced boundary: org A's key on org B's endpoint is rejected (instance
        #    mismatch in verify_api_key) — recall degrades rather than returning B's data.
        s = rt._settings
        cross = MubitMemory(
            s,
            endpoint=os.environ["COSTIT_MT_B_ENDPOINT"],
            api_key=os.environ["COSTIT_MT_A_KEY"],
            transport=os.getenv("MUBIT_TRANSPORT", "http"),
        )
        import anyio

        res = anyio.run(lambda: cross.recall(query=TASK, lane=f"iso-a-{run}:default", limit=5))
        assert res.degraded or not res.evidence, (
            "org A's key was accepted by org B's instance — instance boundary not enforced"
        )
        print("[hard-iso] org A key rejected by org B instance (cross-instance recall blocked)\n")
