"""Feedback endpoint — writes the outcome to Mubit and closes the learning loop."""

from __future__ import annotations

import asyncio
import time

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
from minima.memory.records import (
    EVIDENCE_GATE,
    EVIDENCE_HUMAN,
    EVIDENCE_JUDGE,
    EVIDENCE_NONE,
    OutcomeRecord,
    clamp01,
    is_labeled,
    reconcile_quality,
    signal_from_outcome,
)
from minima.recommender.decisionlog import DecisionRecord, Reconciliation
from minima.schemas.common import OutcomeLabel
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.tenancy.context import TenantContext

log = get_logger("minima.feedback")
router = APIRouter(prefix="/v1", tags=["feedback"])


def _resolve_evidence_source(req: FeedbackRequest) -> str:
    """Explicit evidence_source wins; else derive from the deprecated flags.

    Legacy SDK clients (no judged flag at all) asserted the outcome themselves —
    that is a human label, not an unjudged turn; a harness that explicitly says
    judged=False is declaring the turn unlabeled.
    """
    if req.evidence_source:
        return req.evidence_source
    if req.verified_in_production:
        return EVIDENCE_GATE
    if req.judged:
        return EVIDENCE_JUDGE
    if req.judged is False:
        return EVIDENCE_NONE
    return EVIDENCE_HUMAN


def _supplied_quality(req: FeedbackRequest) -> tuple[float | None, str | None]:
    """Clamp a caller-supplied quality against the outcome label; None stays None."""
    if req.quality_score is None:
        return None, None
    return reconcile_quality(req.outcome.value, clamp01(float(req.quality_score)))


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
        # Degraded late-feedback path: the recstore TTL expired but the decision log
        # (longer retention) still knows the recommendation. The outcome record is still
        # written (the durable (cluster, model) upsert keeps learning); only neighbor
        # attribution and lesson promotion are skipped — the recalled-neighbor ids lived
        # in the recstore alone.
        if settings.minima_late_feedback_enabled and tenant.decision_log is not None:
            decision = tenant.decision_log.get(req.recommendation_id)
            if decision is not None:
                return await _late_feedback(req, tenant, decision)
        return FeedbackResponse(accepted=False, warnings=["unknown_recommendation"])

    source = _resolve_evidence_source(req)
    infra = req.error_cause == "infra"
    labeled = is_labeled(source) and not infra
    quality, mismatch = _supplied_quality(req)
    is_success = req.outcome == OutcomeLabel.success
    verified = labeled and source == EVIDENCE_GATE
    warnings: list[str] = []
    if mismatch:
        warnings.append(mismatch)
        log.warning(
            "quality_outcome_mismatch",
            outcome=req.outcome.value,
            supplied_quality=req.quality_score,
            clamped_quality=quality,
            model_id=req.chosen_model_id,
            cluster=stored.task_cluster,
        )

    # Reconcile the decision-log row BEFORE the Mubit memory write: realized cost/outcome
    # are local analytics facts and must survive a memory outage. (Observed live: a Mubit
    # 503 made every feedback return early and /v1/savings showed 0 reconciled rows for a
    # whole day of traffic.)
    _reconcile_decision(tenant, req, quality, EVIDENCE_NONE if infra else source, late=False)

    if not labeled:
        # Telemetry only: an unjudged turn or an infrastructure fault says nothing about
        # model quality — it must never touch the durable (cluster, model) record,
        # neighbor reinforcement, or lessons. Realized cost/latency live in the
        # decision-log reconcile above.
        warnings.append("infra_failure_telemetry_only" if infra else "unlabeled_telemetry_only")
        return FeedbackResponse(accepted=True, warnings=warnings)

    signal = signal_from_outcome(req.outcome.value, quality)
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
        iterations=req.iterations,
        quality_score=quality,
        outcome=req.outcome.value,
        evidence_source=source,
        recommendation_id=req.recommendation_id,
        verified_in_production=verified,
        recorded_at=time.time(),
    )
    upsert_key = outcome_upsert_key(stored.task_cluster, req.chosen_model_id)
    idem = req.idempotency_key or outcome_idempotency_key(
        req.recommendation_id, req.chosen_model_id
    )
    importance = "high" if (verified and is_success) else "medium"

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

    # The upserted (cluster, model) record's id is stable across feedbacks and
    # dereferenceable — remember it for the exact-match recall fast path.
    if record_id and tenant.durable_refs is not None:
        try:
            tenant.durable_refs.upsert(
                stored.lane, stored.task_cluster, req.chosen_model_id, record_id, record_id
            )
        except Exception as exc:  # noqa: BLE001 — bookkeeping must never fail feedback
            log.warning("durable_ref_upsert_failed", error=str(exc))

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
                verified_in_production=verified,
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
        and verified
        and is_success
        # A deterministic gate pass without a judge score is stronger evidence than
        # any judge number; a supplied quality must still clear the bar.
        and (quality is None or quality >= settings.minima_lesson_min_quality)
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
    if (every > 0 and count % every == 0) or (verified and not is_success):
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


def _reconcile_decision(
    tenant: TenantContext,
    req: FeedbackRequest,
    quality: float | None,
    evidence_source: str,
    *,
    late: bool,
) -> None:
    """Fill the decision-log row's realized columns (best-effort analytics).

    Quality is strictly what the caller supplied — a label-based default is never
    substituted (it would corrupt calibration and OPE). evidence_source lets every
    reader (calibration fit, ECE, CUSUM) filter to trusted labels.
    """
    if tenant.decision_log is None:
        return
    try:
        tenant.decision_log.reconcile(
            req.recommendation_id,
            Reconciliation(
                model_id=req.chosen_model_id,
                outcome=req.outcome.value,
                quality=quality,
                cost_usd=req.actual_cost_usd,
                latency_ms=req.latency_ms,
                ts=time.time(),
                late=late,
                evidence_source=evidence_source,
            ),
        )
    except Exception as exc:  # noqa: BLE001 — analytics must never fail feedback
        log.warning("decision_reconcile_failed", error=str(exc))


async def _late_feedback(
    req: FeedbackRequest,
    tenant: TenantContext,
    decision: DecisionRecord,
) -> FeedbackResponse:
    """Accept feedback after recstore expiry: write the outcome, skip attribution."""
    source = _resolve_evidence_source(req)
    infra = req.error_cause == "infra"
    labeled = is_labeled(source) and not infra
    quality, mismatch = _supplied_quality(req)
    warnings = ["late_feedback_no_attribution"]
    if mismatch:
        warnings.append(mismatch)

    # Realized analytics first — must survive a memory outage (same ordering as the
    # main path).
    _reconcile_decision(tenant, req, quality, EVIDENCE_NONE if infra else source, late=True)

    if not labeled:
        warnings.append("infra_failure_telemetry_only" if infra else "unlabeled_telemetry_only")
        return FeedbackResponse(accepted=True, warnings=warnings)

    record = OutcomeRecord(
        model_id=req.chosen_model_id,
        task_type=decision.task_type,
        difficulty=decision.difficulty,
        task_fingerprint=decision.fingerprint,
        task_cluster=decision.cluster,
        input_tokens=req.input_tokens or 0,
        output_tokens=req.output_tokens or 0,
        cost_usd=req.actual_cost_usd or 0.0,
        latency_ms=req.latency_ms,
        iterations=req.iterations,
        quality_score=quality,
        outcome=req.outcome.value,
        evidence_source=source,
        recommendation_id=req.recommendation_id,
        verified_in_production=source == EVIDENCE_GATE,
        recorded_at=time.time(),
    )
    idem = req.idempotency_key or outcome_idempotency_key(
        req.recommendation_id, req.chosen_model_id
    )
    try:
        record_id = await tenant.memory.remember_outcome(
            content=decision.content,
            record=record,
            lane=decision.lane,
            upsert_key=outcome_upsert_key(decision.cluster, req.chosen_model_id),
            idempotency_key=idem,
            user_id=decision.user_id,
            env_tags=decision.env_tags or None,
            importance="medium",
            source="human",
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("late_remember_outcome_failed", error=str(exc))
        return FeedbackResponse(accepted=False, warnings=["memory_write_failed", *warnings])

    return FeedbackResponse(accepted=True, record_id=record_id, warnings=warnings)
