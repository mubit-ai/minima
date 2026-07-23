"""Classifier program PR-3: the dual-read window. One keyed round trip matches active +
legacy key-space versions; legacy evidence is admitted per model only when the active
cell is thin, at a discounted weight; feedback's read-modify-write base survives the
flip. All behavior is OFF (byte-identical) while minima_cluster_key_read_versions is
empty."""

from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.conftest import TEST_MUBIT_KEY
from tests.factories import make_evidence

V2 = Settings(
    mubit_api_key="test-key",
    minima_cluster_key_version="v2",
    minima_cluster_key_read_versions="v2,v1",
)

TASK = {"task": "refactor this recursive def foo()", "task_type": "code", "difficulty": "hard"}


def _client(fake_memory, settings=V2) -> TestClient:
    app = create_app(settings=settings, memory=fake_memory, start_refresh=False)
    return TestClient(app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"})


def _legacy(entry_id: str, quality: float = 0.9):
    return make_evidence(
        "claude-sonnet-5", quality, entry_id=entry_id, task_cluster="code:hard"
    )


def _active(entry_id: str, quality: float = 0.9):
    return make_evidence(
        "claude-sonnet-5", quality, entry_id=entry_id, task_cluster="code:hard:v2"
    )


def test_one_lookup_matches_every_read_version(fake_memory):
    with _client(fake_memory) as client:
        assert client.post("/v1/recommend", json={"task": TASK}).status_code == 200
    keys = {m["task_cluster"] for call in fake_memory.lookup_calls for m in call["match"]}
    assert "code:hard:v2" in keys
    assert "code:hard" in keys
    assert len(fake_memory.lookup_calls) == 1  # one round trip — never a stacked read


def test_empty_read_versions_is_byte_identical(fake_memory):
    settings = Settings(mubit_api_key="test-key", minima_cluster_key_version="v2")
    with _client(fake_memory, settings) as client:
        assert client.post("/v1/recommend", json={"task": TASK}).status_code == 200
    keys = {m["task_cluster"] for call in fake_memory.lookup_calls for m in call["match"]}
    assert keys == {"code:hard:v2"}


def test_thin_active_cell_admits_discounted_legacy_evidence(fake_memory):
    fake_memory.lookup_results = [_legacy("l1"), _legacy("l2"), _legacy("l3")]
    with _client(fake_memory) as client:
        rec = client.post("/v1/recommend", json={"task": TASK}).json()
    haiku = next(r for r in rec["ranked"] if r["model_id"] == "claude-sonnet-5")
    assert {e["entry_id"] for e in haiku["evidence"]} >= {"l1", "l2", "l3"}
    assert haiku["decision_basis"] != "prior"


def test_thick_active_cell_drops_legacy_evidence(fake_memory):
    fake_memory.lookup_results = [
        _active("a1"),
        _active("a2"),
        _active("a3"),
        _legacy("l1"),
        _legacy("l2"),
    ]
    with _client(fake_memory) as client:
        rec = client.post("/v1/recommend", json={"task": TASK}).json()
    haiku = next(r for r in rec["ranked"] if r["model_id"] == "claude-sonnet-5")
    ids = {e["entry_id"] for e in haiku["evidence"]}
    assert {"a1", "a2", "a3"} <= ids
    assert not ids & {"l1", "l2"}


def test_feedback_previous_record_falls_back_to_legacy_key(fake_memory):
    fake_memory.lookup_results = []
    with _client(fake_memory) as client:
        rec = client.post("/v1/recommend", json={"task": TASK}).json()
        fake_memory.lookup_calls.clear()
        resp = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": rec["recommended_model"]["model_id"],
                "outcome": "success",
                "evidence_source": "gate",
                "actual_cost_usd": 0.001,
            },
        )
        assert resp.status_code == 200 and resp.json()["accepted"] is True
    keys = [m["task_cluster"] for call in fake_memory.lookup_calls for m in call["match"]]
    assert any(k.endswith(":v2") for k in keys)
    assert any(k.count(":") == 1 for k in keys)  # the stripped v1 sibling was consulted
