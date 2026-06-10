from __future__ import annotations

from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from tests.factories import FakeMemory

TASK = {"task": "refactor a recursive parser into an iterative loop", "task_type": "code"}


def _recommend(client: TestClient) -> tuple[str, str]:
    resp = client.post("/v1/recommend", json={"task": TASK, "allow_llm_escalation": False})
    assert resp.status_code == 200
    body = resp.json()
    return body["recommendation_id"], body["recommended_model"]["model_id"]


def _client(memory: FakeMemory) -> TestClient:
    app = create_app(settings=Settings(mubit_api_key="t"), memory=memory, start_refresh=False)
    return TestClient(app)


def test_verified_prod_success_promotes_lesson():
    memory = FakeMemory()
    with _client(memory) as client:
        rec_id, model = _recommend(client)
        resp = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": model,
                "outcome": "success",
                "quality_score": 0.95,
                "verified_in_production": True,
            },
        )
    assert resp.status_code == 200
    assert resp.json()["lesson_promoted"] is True
    assert len(memory.lessons) == 1
    lesson = memory.lessons[0]
    assert lesson["upsert_key"].startswith("minima:lesson:code:")
    assert lesson["metadata"]["model_id"] == model


def test_no_lesson_without_verified_or_high_quality():
    memory = FakeMemory()
    with _client(memory) as client:
        # Not verified in production -> no lesson.
        rid, model = _recommend(client)
        r1 = client.post(
            "/v1/feedback",
            json={"recommendation_id": rid, "chosen_model_id": model, "outcome": "success",
                  "quality_score": 0.95, "verified_in_production": False},
        )
        # Verified but low quality -> no lesson.
        rid2, model2 = _recommend(client)
        r2 = client.post(
            "/v1/feedback",
            json={"recommendation_id": rid2, "chosen_model_id": model2, "outcome": "partial",
                  "quality_score": 0.5, "verified_in_production": True},
        )
    assert r1.json()["lesson_promoted"] is False
    assert r2.json()["lesson_promoted"] is False
    assert memory.lessons == []


def test_lesson_promotion_can_be_disabled():
    memory = FakeMemory()
    settings = Settings(mubit_api_key="t", minima_lesson_on_verified_prod=False)
    app = create_app(settings=settings, memory=memory, start_refresh=False)
    with TestClient(app) as client:
        rid, model = _recommend(client)
        resp = client.post(
            "/v1/feedback",
            json={"recommendation_id": rid, "chosen_model_id": model, "outcome": "success",
                  "quality_score": 0.99, "verified_in_production": True},
        )
    assert resp.json()["lesson_promoted"] is False
    assert memory.lessons == []
