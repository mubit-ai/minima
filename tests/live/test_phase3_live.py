"""Live checks for Phase 3 paths against a real Mubit runtime.

    MUBIT_ENDPOINT=http://127.0.0.1:3000 MUBIT_API_KEY=... MUBIT_TRANSPORT=http \
    uv run pytest -m live -k phase3 -q
"""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from costit.config import Settings
from costit.main import create_app
from costit.memory.adapter import MubitMemory
from costit.memory.keys import build_lesson_content, lesson_upsert_key
from costit.recommender.recstore import SqliteRecommendationStore

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"
    ),
]

TASK = "Refactor a recursive descent parser into an iterative state machine with a stack"


async def test_phase3_remember_lesson_and_surface_strategies_live():
    settings = Settings(costit_memory_recall_timeout_ms=8000)
    memory = MubitMemory(settings)
    namespace = "p3-" + uuid.uuid4().hex[:8]
    lane = settings.lane(namespace)
    cluster = "code:hard"
    model = "claude-haiku-4-5"

    record_id = await memory.remember_lesson(
        content=build_lesson_content(cluster, model, 0.95),
        lane=lane,
        upsert_key=lesson_upsert_key(cluster, model),
        metadata={"kind": "lesson", "task_cluster": cluster, "model_id": model},
        idempotency_key=f"lsn-{namespace}",
    )
    assert record_id is None or isinstance(record_id, str)

    strategies = await memory.surface_strategies(lane=lane, max_strategies=5)
    assert isinstance(strategies, dict)


def test_phase3_sqlite_recstore_and_lesson_promotion_via_api_live(tmp_path):
    db = str(tmp_path / "recstore.db")
    settings = Settings(
        costit_reflect_every_n=0,
        costit_memory_recall_timeout_ms=8000,
        costit_recommendation_store="sqlite",
        costit_sqlite_path=db,
    )
    namespace = "p3api-" + uuid.uuid4().hex[:8]
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app) as client:
        rec = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
            },
        )
        assert rec.status_code == 200
        body = rec.json()
        rec_id = body["recommendation_id"]
        model = body["recommended_model"]["model_id"]

        # The recommendation was persisted durably (a fresh sqlite handle sees it).
        assert SqliteRecommendationStore(db).get(rec_id) is not None

        fb = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": model,
                "outcome": "success",
                "quality_score": 0.95,
                "verified_in_production": True,
            },
        )
        assert fb.status_code == 200
        assert fb.json()["accepted"] is True
        assert fb.json()["lesson_promoted"] is True

        strat = client.get("/v1/strategies", params={"namespace": namespace})
        assert strat.status_code == 200
        assert strat.json()["lane"] == f"costit:{namespace}"
