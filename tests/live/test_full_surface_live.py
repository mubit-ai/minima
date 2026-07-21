"""Comprehensive live surface + learning-loop suite against a real Mubit runtime.

No mocks: every test drives the real FastAPI app (which builds a real MubitMemory
from the environment) and/or a real ``MubitMemory`` directly. Each test gets a fresh
unique namespace so they never collide on the shared Mubit instance.

Run with a Mubit runtime up (e.g. `make run-mubit` in the Mubit repo) and:
    MUBIT_ENDPOINT=http://127.0.0.1:3000 MUBIT_API_KEY=... MUBIT_TRANSPORT=http \
    uv run pytest -m live -k full_surface -q

The local CPU embedder is slow (~1.5s/recall), so every recall budget is set to
8000ms. The reasoner-backed escalation test additionally needs GEMINI_API_KEY.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from minima.config import Settings
from minima.main import create_app
from minima.memory.adapter import MubitMemory
from minima.memory.keys import build_content, task_cluster, task_fingerprint
from minima.memory.records import OutcomeRecord
from minima.recommender.recstore import SqliteRecommendationStore
from minima.seeding.items import SeedItem, build_item

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"
    ),
]

RECALL_TIMEOUT_MS = 8000


def _auth_headers() -> dict[str, str]:
    """Pass-through auth: every API route requires the Mubit key as a bearer token."""
    return {"Authorization": f"Bearer {os.environ['MUBIT_API_KEY']}"}

# A cohesive "code:hard" task family. Seeds reuse near-identical text so the recall
# query embeds close to them and surfaces the seeded outcomes.
TASK_FAMILY = (
    "Refactor a recursive descent parser into an iterative state machine with an "
    "explicit stack and memoization for repeated subexpressions"
)
TASK_FAMILY_VARIANT = (
    "Rewrite a recursive descent parser as an iterative stack-based state machine "
    "with memoization of repeated subexpressions"
)


def _ns(prefix: str = "live") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _base_settings(**overrides) -> Settings:
    """Settings for the memory-only (no reasoner) live tests."""
    base: dict = {
        "minima_memory_recall_timeout_ms": RECALL_TIMEOUT_MS,
        "minima_reflect_every_n": 0,
    }
    base.update(overrides)
    return Settings(**base)


def _seed_family(
    *,
    settings: Settings,
    namespace: str,
    task_type: str,
    difficulty: str,
    text: str,
    model_quality: list[tuple[str, float]],
) -> list[SeedItem]:
    """Build SeedItems for one task family; quality >= 0.5 -> success else failure.

    Each item gets slightly varied text (a distinct phrasing of the same family) so the
    records stay distinct under the server's content de-duplication, while still embedding
    close to the family query.
    """
    lane = settings.lane(namespace)
    cluster = task_cluster(task_type, difficulty)
    items: list[SeedItem] = []
    for i, (model, q) in enumerate(model_quality):
        variant = f"{text} (scenario {i})"
        items.append(
            SeedItem(
                item_id=f"{lane}-{i}",
                content=build_content(task_type, difficulty, variant),
                record=OutcomeRecord(
                    model_id=model,
                    task_type=task_type,
                    difficulty=difficulty,
                    task_fingerprint=task_fingerprint(variant),
                    task_cluster=cluster,
                    quality_score=q,
                    evidence_source="judge",
                    outcome="success" if q >= 0.5 else "failure",
                ),
                env_tags=["seed:livetest"],
            )
        )
    return items


# --------------------------------------------------------------------------------------
# 1. recommend cold-start
# --------------------------------------------------------------------------------------
def test_recommend_cold_start_live():
    settings = _base_settings()
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["decision_basis"] == "prior"
        assert body["recommended_model"]["decision_basis"] == "prior"
        assert "cold_start" in body["warnings"]


# --------------------------------------------------------------------------------------
# 2. recommend memory-driven
# --------------------------------------------------------------------------------------
async def test_recommend_memory_driven_live():
    settings = _base_settings()
    namespace = _ns()
    memory = MubitMemory(settings)
    lane = settings.lane(namespace)

    # A cheap model (gpt-4o-mini) succeeded repeatedly on this family; an expensive one
    # (claude-opus-4-8) is unseen. With a cost-leaning caller the cheap winner emerges.
    seeds = _seed_family(
        settings=settings,
        namespace=namespace,
        task_type="code",
        difficulty="hard",
        text=TASK_FAMILY,
        model_quality=[("gpt-4o-mini", q) for q in (0.92, 0.9, 0.91, 0.93, 0.9, 0.88)],
    )
    inserted = await memory.batch_insert(run_id=lane, items=[build_item(s) for s in seeds])
    assert inserted.get("count", 0) >= 5  # server may de-dup near-identical family text

    # Recall is eventually-consistent after ingest (server embeds on insert); poll briefly.
    recalled_models: set[str] = set()
    for _ in range(8):
        recall = await memory.recall(
            query=TASK_FAMILY_VARIANT, lane=lane, limit=25, timeout_ms=RECALL_TIMEOUT_MS
        )
        recalled_models = {e.record.model_id for e in recall.outcome_evidence if e.record}
        if "gpt-4o-mini" in recalled_models:
            break
        time.sleep(1.0)
    assert "gpt-4o-mini" in recalled_models

    app = create_app(settings=settings, start_refresh=False)
    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.post(
            "/v1/recommend",
            json={
                "task": {
                    "task": TASK_FAMILY_VARIANT,
                    "task_type": "code",
                    "difficulty": "hard",
                },
                "namespace": namespace,
                "cost_quality_tradeoff": 3.0,  # cost-leaning caller
                "constraints": {
                    "candidate_models": ["gpt-4o-mini", "claude-opus-4-8"]
                },
                "allow_llm_escalation": False,
                "explain": True,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        recall_degraded = (
            "recall_timeout",
            "memory_unavailable",
            "memory_unreachable",
            "memory_auth_failed",
            "memory_rejected_payload",
            "memory_server_error",
            "memory_recall_bug",
        )
        if any(w in body.get("warnings", []) for w in recall_degraded):
            pytest.skip(f"Mubit recall unavailable during app recommend: {body['warnings']}")
        assert body["decision_basis"] == "memory"
        assert body["recommended_model"]["model_id"] == "gpt-4o-mini"
        assert body["recommended_model"]["decision_basis"] == "memory"


# --------------------------------------------------------------------------------------
# 3. feedback reinforcement loop
# --------------------------------------------------------------------------------------
def test_feedback_reinforcement_loop_live():
    settings = _base_settings()
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        first = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
                "explain": True,
            },
        )
        assert first.status_code == 200
        first_body = first.json()
        rec_id = first_body["recommendation_id"]
        model = first_body["recommended_model"]["model_id"]

        fb = client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec_id,
                "chosen_model_id": model,
                "outcome": "success",
                "quality_score": 0.95,
            },
        )
        assert fb.status_code == 200
        assert fb.json()["accepted"] is True

        second = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
                "explain": True,
            },
        )
        assert second.status_code == 200
        second_body = second.json()

        # The feedback outcome is now recalled: the just-fed model carries memory
        # evidence the second time around.
        by_id = {m["model_id"]: m for m in second_body["ranked"]}
        fed = by_id.get(model) or second_body["recommended_model"]
        assert fed["decision_basis"] == "memory"
        assert len(fed["evidence"]) >= 1


# --------------------------------------------------------------------------------------
# 4. llm escalation (requires the gemini reasoner)
# --------------------------------------------------------------------------------------
def test_llm_escalation_live():
    settings = Settings(
        minima_memory_recall_timeout_ms=RECALL_TIMEOUT_MS,
        minima_reflect_every_n=0,
    )
    namespace = _ns()  # cold namespace -> thin evidence -> escalation
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": True,
                "constraints": {
                    "candidate_models": ["gpt-4o-mini", "gemini-2.5-flash", "claude-opus-4-8"]
                },
                "explain": True,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        # Escalation must fire on a cold namespace (thin evidence) — DIAGNOSTIC only:
        # the reasoner was deleted; the harness recovery ladder owns the cascade.
        assert any(w.startswith("escalation_suggested:") for w in body["warnings"])
        assert body["decision_basis"] in ("memory", "prior")
        assert "reasoner_consulted" not in body["warnings"]


# --------------------------------------------------------------------------------------
# 5. workflow endpoint
# --------------------------------------------------------------------------------------
def test_workflow_endpoint_live():
    settings = _base_settings()
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.post(
            "/v1/recommend/workflow",
            json={
                "steps": [
                    {
                        "step_id": "reason",
                        "task": {
                            "task": (
                                "Prove that the proposed distributed consensus protocol "
                                "is safe under network partitions and derive its liveness "
                                "guarantees"
                            ),
                            "task_type": "reasoning",
                            "difficulty": "hard",
                        },
                    },
                    {
                        "step_id": "classify",
                        "task": {
                            "task": "Classify this support ticket as billing, bug, or other",
                            "task_type": "classification",
                            "difficulty": "easy",
                        },
                    },
                ],
                "cost_quality_tradeoff": 5.0,
                "namespace": namespace,
                "allow_llm_escalation": False,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        step_ids = {s["step_id"] for s in body["steps"]}
        assert step_ids == {"reason", "classify"}
        for step in body["steps"]:
            assert step["recommendation"]["recommended_model"]["model_id"]
        assert body["total_est_cost_usd"] <= body["total_est_cost_if_all_premium"]


# --------------------------------------------------------------------------------------
# 6. lesson promotion + strategies
# --------------------------------------------------------------------------------------
def test_lesson_promotion_and_strategies_live():
    settings = _base_settings()
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        rec = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
            },
        )
        assert rec.status_code == 200
        rec_body = rec.json()
        rec_id = rec_body["recommendation_id"]
        model = rec_body["recommended_model"]["model_id"]

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
        assert fb.json()["lesson_promoted"] is True

        strat = client.get("/v1/strategies", params={"namespace": namespace})
        assert strat.status_code == 200
        assert strat.json()["lane"] == f"minima:{namespace}"


# --------------------------------------------------------------------------------------
# 7. reflect cadence
# --------------------------------------------------------------------------------------
def test_reflect_cadence_live():
    settings = _base_settings(minima_reflect_every_n=2)
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        triggered: list[bool] = []
        for _ in range(2):
            rec = client.post(
                "/v1/recommend",
                json={
                    "task": {
                        "task": TASK_FAMILY,
                        "task_type": "code",
                        "difficulty": "hard",
                    },
                    "namespace": namespace,
                    "allow_llm_escalation": False,
                },
            )
            assert rec.status_code == 200
            rec_body = rec.json()
            fb = client.post(
                "/v1/feedback",
                json={
                    "recommendation_id": rec_body["recommendation_id"],
                    "chosen_model_id": rec_body["recommended_model"]["model_id"],
                    "outcome": "success",
                    "quality_score": 0.9,
                },
            )
            assert fb.status_code == 200
            triggered.append(fb.json()["reflection_triggered"])

        # reflect_every_n=2: the 2nd feedback in this lane crosses the cadence.
        assert triggered[1] is True


# --------------------------------------------------------------------------------------
# 8. durable sqlite recstore
# --------------------------------------------------------------------------------------
def test_durable_sqlite_recstore_live(tmp_path):
    db = str(tmp_path / "rs.db")
    settings = _base_settings(
        minima_recommendation_store="sqlite",
        minima_sqlite_path=db,
    )
    namespace = _ns()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        rec = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "allow_llm_escalation": False,
            },
        )
        assert rec.status_code == 200
        rec_id = rec.json()["recommendation_id"]

    # A fresh sqlite handle (simulating a restart) still sees the recommendation.
    fresh = SqliteRecommendationStore(db)
    assert fresh.get(rec_id) is not None
    fresh.close()


# --------------------------------------------------------------------------------------
# 9. models endpoint
# --------------------------------------------------------------------------------------
def test_models_endpoint_live():
    settings = _base_settings()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.get("/v1/models")
        assert resp.status_code == 200
        body = resp.json()
        assert body["models"]
        for card in body["models"]:
            assert card["model_id"]
            assert "input_cost_per_mtok" in card


# --------------------------------------------------------------------------------------
# 10. health endpoint
# --------------------------------------------------------------------------------------
def test_health_endpoint_live():
    settings = _base_settings()
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.get("/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] in {"ok", "degraded"}
        assert body["mubit"]["reachable"] is True


# --------------------------------------------------------------------------------------
# 11. constraints
# --------------------------------------------------------------------------------------
def test_constraints_candidate_models_live():
    settings = _base_settings()
    namespace = _ns()
    allowed = ["gpt-4o-mini", "claude-opus-4-8"]
    app = create_app(settings=settings, start_refresh=False)

    with TestClient(app, headers=_auth_headers()) as client:
        resp = client.post(
            "/v1/recommend",
            json={
                "task": {"task": TASK_FAMILY, "task_type": "code", "difficulty": "hard"},
                "namespace": namespace,
                "constraints": {"candidate_models": allowed},
                "allow_llm_escalation": False,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["recommended_model"]["model_id"] in allowed
