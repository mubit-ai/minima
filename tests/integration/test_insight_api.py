from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.factories import FakeMemory


class _BrokenMemory(FakeMemory):
    async def diagnose(self, **_kwargs):
        raise RuntimeError("mubit unreachable")

    async def memory_health(self, **_kwargs):
        raise RuntimeError("mubit unreachable")


def _client(memory: FakeMemory) -> TestClient:
    app = create_app(settings=Settings(mubit_api_key="t"), memory=memory, start_refresh=False)
    return TestClient(app, headers={"Authorization": "Bearer mbt_test_kid_secret"})


def test_diagnose_relays_failure_lessons():
    memory = FakeMemory()
    memory.diagnose_result = {
        "failure_lessons": [
            {
                "lesson_id": "l1",
                "content": "pytest hangs when the venv is patched",
                "lesson_type": "failure",
                "importance": "high",
                "confidence": 0.8,
            }
        ],
        "summary": "1 matching failure lesson",
        "total_failure_lessons": 4,
    }
    with _client(memory) as client:
        resp = client.post(
            "/v1/diagnose",
            json={"error_text": "pytest timed out after 300s", "namespace": "acme"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["lane"] == "minima:acme"
    assert body["total_failure_lessons"] == 4
    assert body["failure_lessons"][0]["content"].startswith("pytest hangs")
    assert memory.diagnose_calls[0]["error_text"] == "pytest timed out after 300s"
    assert memory.diagnose_calls[0]["lane"] == "minima:acme"


def test_diagnose_degrades_when_memory_unavailable():
    with _client(_BrokenMemory()) as client:
        resp = client.post("/v1/diagnose", json={"error_text": "boom"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["failure_lessons"] == []
    assert body["warnings"] == ["memory_unavailable"]


def test_diagnose_requires_error_text():
    with _client(FakeMemory()) as client:
        resp = client.post("/v1/diagnose", json={"error_text": ""})
    assert resp.status_code == 422


def test_memory_health_relays_hygiene_report():
    memory = FakeMemory()
    memory.memory_health_result = {
        "entry_counts": {"observation": 120, "lesson": 8},
        "stale_entries": 5,
        "contradictions": 1,
        "low_confidence_count": 3,
        "promotion_candidates": 2,
        "section_health": {"lessons": "ok"},
    }
    with _client(memory) as client:
        resp = client.get(
            "/v1/memory/health", params={"namespace": "acme", "stale_threshold_days": 14}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["lane"] == "minima:acme"
    assert body["entry_counts"] == {"observation": 120, "lesson": 8}
    assert body["stale_entries"] == 5
    assert body["contradictions"] == 1
    assert body["promotion_candidates"] == 2
    assert memory.memory_health_calls[0]["stale_threshold_days"] == 14


def test_memory_health_degrades_when_memory_unavailable():
    with _client(_BrokenMemory()) as client:
        resp = client.get("/v1/memory/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["warnings"] == ["memory_unavailable"]
    assert body["entry_counts"] == {}
