"""End-to-end against a real Mubit runtime.

Run with a Mubit runtime up (e.g. `make run-mubit` in the Mubit repo) and:
    MUBIT_ENDPOINT=http://127.0.0.1:3000 MUBIT_API_KEY=... MUBIT_TRANSPORT=http \
    uv run pytest -m live -q
"""

from __future__ import annotations

import os
import uuid

import pytest

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.memory.adapter import MubitMemory
from minima.memory.keys import build_content, outcome_upsert_key, task_cluster, task_fingerprint
from minima.memory.records import OutcomeRecord
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from minima.seeding.items import SeedItem, build_item

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"
    ),
]

TASK = (
    "Refactor a recursive descent parser into an iterative state machine with an "
    "explicit stack and memoization for repeated subexpressions"
)


async def test_seed_recommend_feedback_roundtrip():
    namespace = "e2e-" + uuid.uuid4().hex[:8]
    # Generous recall budget: the local CPU embedder is slow and variable; the
    # production default (2500ms) targets a fast GPU embedder.
    settings = Settings(minima_reflect_every_n=0, minima_memory_recall_timeout_ms=8000)
    memory = MubitMemory(settings)
    lane = settings.lane(namespace)
    cluster = task_cluster("code", "hard")
    fingerprint = task_fingerprint(TASK)
    content = build_content("code", "hard", TASK)

    # Seed: Haiku succeeded twice on this cluster; gpt-4o-mini failed.
    seeds = [
        SeedItem(
            item_id=f"{lane}-{i}",
            content=content,
            record=OutcomeRecord(
                model_id=model,
                task_type="code",
                difficulty="hard",
                task_fingerprint=fingerprint,
                task_cluster=cluster,
                quality_score=q,
                outcome="success" if q >= 0.5 else "failure",
                evidence_source="judge",
            ),
            env_tags=["seed:e2e"],
        )
        for i, (model, q) in enumerate(
            [("claude-haiku-4-5", 0.9), ("claude-haiku-4-5", 0.88), ("gpt-4o-mini", 0.1)]
        )
    ]
    inserted = await memory.batch_insert(run_id=lane, items=[build_item(s) for s in seeds])
    assert inserted.get("count", 0) >= 3

    # Seeded outcomes are recalled and parsed (kind=outcome) despite being stored as facts.
    recall = await memory.recall(query=TASK, lane=lane, limit=25, timeout_ms=5000)
    recalled_models = {e.record.model_id for e in recall.outcome_evidence if e.record}
    assert "claude-haiku-4-5" in recalled_models

    # Recommend: Haiku (memory success, cheap) beats gpt-4o-mini (memory failure).
    engine = Recommender(settings, memory, CatalogStore(settings), RecommendationStore())
    req = RecommendRequest(
        task=TaskInput(task=TASK, task_type="code", difficulty="hard"),
        namespace=namespace,
        cost_quality_tradeoff=3.0,  # cost-leaning caller
        constraints=Constraints(
            candidate_models=["claude-haiku-4-5", "gpt-4o-mini", "claude-opus-4-8"]
        ),
    )
    resp = await engine.recommend(req)
    assert resp.recommended_model.model_id == "claude-haiku-4-5"
    assert resp.recommended_model.decision_basis == "memory"

    # Feedback: write the new outcome and reinforce the neighbors that informed it.
    stored = engine._recstore.get(resp.recommendation_id)  # noqa: SLF001 (test introspection)
    assert stored is not None
    record_id = await memory.remember_outcome(
        content=stored.content,
        record=OutcomeRecord(
            model_id=resp.recommended_model.model_id,
            task_type="code",
            difficulty="hard",
            task_cluster=cluster,
            quality_score=0.95,
            evidence_source="judge",
            outcome="success",
            recommendation_id=resp.recommendation_id,
        ),
        lane=lane,
        upsert_key=outcome_upsert_key(cluster, resp.recommended_model.model_id),
        idempotency_key=f"e2e-{resp.recommendation_id}",
        source="human",
    )
    assert record_id

    neighbors = stored.neighbors_by_model.get(resp.recommended_model.model_id, [])
    entry_ids = [eid for eid, _ in neighbors if eid]
    reference_id = next((ref for _eid, ref in neighbors if ref), None) or record_id
    outcome = await memory.record_outcome(
        lane=lane,
        reference_id=reference_id,
        outcome="success",
        signal=1.0,
        entry_ids=entry_ids or None,
        idempotency_key=f"oc-e2e-{resp.recommendation_id}",
        rationale="e2e roundtrip",
    )
    assert isinstance(outcome, dict)
