from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.factories import FakeMemory


class _BrokenMemory(FakeMemory):
    async def surface_strategies(self, **_kwargs):
        raise RuntimeError("mubit unreachable (401)")


EMERGENT = {
    "strategy_id": "s1",
    "description": "Route code:easy tasks to claude-haiku-4-5.",
    "supporting_lesson_count": 6,
    "avg_confidence": 0.84,
    "dominant_lesson_type": "success",
    "dominant_scope": "session",
    "lesson_ids": ["l1", "l2"],
}


def test_strategies_endpoint_returns_normalized_rules():
    memory = FakeMemory(strategies=[EMERGENT])
    app = create_app(settings=Settings(mubit_api_key="t"), memory=memory, start_refresh=False)
    with TestClient(app, headers={"Authorization": "Bearer mbt_test_kid_secret"}) as client:
        resp = client.get("/v1/strategies", params={"namespace": "acme", "max_strategies": 3})
    assert resp.status_code == 200
    body = resp.json()
    assert body["lane"] == "minima:acme"
    assert body["namespace"] == "acme"
    assert body["count"] == 1
    assert body["strategies"][0]["description"].startswith("Route code:easy")
    assert body["strategies"][0]["supporting_lesson_count"] == 6


def test_strategies_endpoint_empty():
    app = create_app(settings=Settings(mubit_api_key="t"), memory=FakeMemory(), start_refresh=False)
    with TestClient(app, headers={"Authorization": "Bearer mbt_test_kid_secret"}) as client:
        resp = client.get("/v1/strategies")
    assert resp.status_code == 200
    assert resp.json() == {
        "namespace": None,
        "lane": "minima:default",
        "strategies": [],
        "count": 0,
        "warnings": [],
    }


def test_strategies_endpoint_degrades_when_memory_unavailable():
    # A Mubit outage must not 500 this read — it degrades like the recommend hot path.
    app = create_app(
        settings=Settings(mubit_api_key="t"), memory=_BrokenMemory(), start_refresh=False
    )
    with TestClient(app, headers={"Authorization": "Bearer mbt_test_kid_secret"}) as client:
        resp = client.get("/v1/strategies", params={"namespace": "acme"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["strategies"] == []
    assert body["count"] == 0
    assert body["warnings"] == ["memory_unavailable"]
