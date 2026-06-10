"""Feedback endpoint — writes the outcome to Mubit and closes the learning loop."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from minima.api.auth import get_tenant
from minima.config import Settings
from minima.deps import get_settings
from minima.logging import get_logger
from minima.memory.adapter import Memory
from minima.memory.keys import (
    build_lesson_content,
    lesson_upsert_key,
    outcome_idempotency_key,
    outcome_upsert_key,
)
from minima.memory.records import OutcomeRecord, quality_from_outcome, signal_from_outcome
from minima.schemas.common import OutcomeLabel
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.tenancy.context import TenantContext

log = get_logger("minima.feedback")
router = APIRouter(prefix="/v1", tags=["feedback"])


def _fire_reflect(memory: Memory, lane: str, user_id: str | None) -> None:
    async def _run() -> None:
        try:
            await memory.reflect(lane=lane, user_id=user_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("reflect_failed", lane=lane, error=str(exc))

    asyncio.create_task(_run())  # noqa: RUF006 — fire-and-forget, errors are logged


@router.post("/feedback", response_model=FeedbackResponse)
async def feedback(
    req: FeedbackRequest,
    tenant: TenantContext = Depends(get_tenant),
    settings: Settings = Depends(get_settings),
) -> FeedbackResponse:
    memory = tenant.memory
    # Org-scoped store: a recommendation_id minted for another org resolves to None here,
    # so org A cannot credit or poison org B's recommendation.
    stored = tenant.recstore.get(req.recommendation_id)
    if stored is None:
        return FeedbackResponse(accepted=False, warnings=["unknown_recommendation"])

    quality = quality_from_outcome(req.outcome.value, req.quality_score)
    signal = signal_from_outcome(req.outcome.value, quality)
    is_success = req.outcome == OutcomeLabel.success

    record = OutcomeRecord(
        model_id=req.chosen_model_id,
        task_type=stored.task_type,
        difficulty=stored.difficulty,
        task_fingerprint=stored.task_fingerprint,
        task_cluster=stored.task_cluster,
        input_tokens=req.input_tokens or 0,
        output_tokens=req.output_tokens or 0,
        cost_usd=req.actual_cost_usd or 0.0,
        latency_ms=req.latency_ms,
        quality_score=quality,
        outcome=req.outcome.value,
        recommendation_id=req.recommendation_id,
        verified_in_production=req.verified_in_production,
    )
    upsert_key = outcome_upsert_key(stored.task_cluster, req.chosen_model_id)
    idem = req.idempotency_key or outcome_idempotency_key(
        req.recommendation_id, req.chosen_model_id
    )
    importance = "high" if (req.verified_in_production and is_success) else "medium"
    warnings: list[str] = []

    try:
        record_id = await memory.remember_outcome(
            content=stored.content,
            record=record,
            lane=stored.lane,
            upsert_key=upsert_key,
            idempotency_key=idem,
            user_id=stored.user_id,
            env_tags=stored.env_tags or None,
            importance=importance,
            source="human",
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("remember_outcome_failed", error=str(exc))
        return FeedbackResponse(accepted=False, warnings=["memory_write_failed"])

    neighbors = stored.neighbors_by_model.get(req.chosen_model_id, [])
    entry_ids = [eid for (eid, _ref) in neighbors if eid]
    primary_ref = next((ref for (_eid, ref) in neighbors if ref), None) or record_id

    updated_confidence: float | None = None
    if primary_ref:
        try:
            oc = await memory.record_outcome(
                lane=stored.lane,
                reference_id=primary_ref,
                outcome=req.outcome.value,
                signal=signal,
                entry_ids=entry_ids or None,
                user_id=stored.user_id,
                verified_in_production=req.verified_in_production,
                idempotency_key=f"oc:{idem}",
                rationale=f"minima feedback {req.recommendation_id}: ran {req.chosen_model_id}",
            )
            value = oc.get("updated_confidence")
            updated_confidence = float(value) if value is not None else None
        except Exception as exc:  # noqa: BLE001
            log.warning("record_outcome_failed", error=str(exc))
            warnings.append("reinforcement_failed")

    # Promote a verified-in-production strong success to a durable Lesson. Lessons pass
    # the server's validation gate and feed reflect()/surface_strategies rule promotion;
    # a per-(cluster, model) upsert_key keeps one accumulating lesson instead of flooding.
    lesson_promoted = False
    if (
        settings.minima_lesson_on_verified_prod
        and req.verified_in_production
        and is_success
        and quality >= settings.minima_lesson_min_quality
    ):
        try:
            await memory.remember_lesson(
                content=build_lesson_content(stored.task_cluster, req.chosen_model_id, quality),
                lane=stored.lane,
                upsert_key=lesson_upsert_key(stored.task_cluster, req.chosen_model_id),
                user_id=stored.user_id,
                env_tags=stored.env_tags or None,
                metadata={
                    "kind": "lesson",
                    "task_cluster": stored.task_cluster,
                    "model_id": req.chosen_model_id,
                    "verified_in_production": True,
                },
                idempotency_key=f"lsn:{idem}",
            )
            lesson_promoted = True
        except Exception as exc:  # noqa: BLE001 — lesson promotion is best-effort
            log.warning("lesson_promotion_failed", error=str(exc))
            warnings.append("lesson_promotion_failed")

    reflection_triggered = False
    count = tenant.lane_counter.bump(tenant.counter_key(stored.lane))
    every = settings.minima_reflect_every_n
    if (every > 0 and count % every == 0) or (req.verified_in_production and not is_success):
        _fire_reflect(memory, stored.lane, stored.user_id)
        reflection_triggered = True

    return FeedbackResponse(
        accepted=True,
        record_id=record_id,
        reinforced_entry_ids=entry_ids,
        updated_confidence=updated_confidence,
        reflection_triggered=reflection_triggered,
        lesson_promoted=lesson_promoted,
        warnings=warnings,
    )
