"""Feedback endpoint — writes the outcome to Mubit and closes the learning loop."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends

from minima.api.auth import get_tenant
from minima.config import Settings
from minima.deps import get_settings
from minima.logging import get_logger
from minima.memory import threadpool
from minima.memory.adapter import Memory, classify_memory_error
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
    RECALL_VOTE_CAP,
    TRUSTED_LABEL_SOURCES,
    OutcomeRecord,
    clamp01,
    fold_recall_vote,
    is_labeled,
    label_score,
    merged_outcome,
    reconcile_quality,
    should_invalidate,
    signal_from_outcome,
)
from minima.recommender.decisionlog import DecisionRecord, Reconciliation
from minima.recommender.pairs import assemble_pair
from minima.schemas.common import OutcomeLabel
from minima.schemas.feedback import FeedbackRequest, FeedbackResponse
from minima.tenancy.context import TenantContext

log = get_logger("minima.feedback")
router = APIRouter(prefix="/v1", tags=["feedback"])


def _record_label_signals(tenant: TenantContext, req: FeedbackRequest) -> None:
    """Hand the label model its feedback facts (implicit signals, step summary,
    iterations). Strictly best-effort: a no-op unless MINIMA_LABEL_MODEL is on."""
    try:
        steps_all_success = (
            all(s.outcome == OutcomeLabel.success for s in req.step_outcomes)
            if req.step_outcomes
            else None
        )
        tenant.recommender.record_feedback_signals(
            req.recommendation_id,
            signals=req.signals,
            steps_all_success=steps_all_success,
            iterations=req.iterations,
        )
    except Exception as exc:  # noqa: BLE001 — label bookkeeping must never fail feedback
        log.warning("label_signal_record_failed", error=str(exc))


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


async def _previous_record(
    tenant: TenantContext, lane: str, cluster: str, model_id: str
) -> OutcomeRecord | None:
    """Read the current durable (cluster, model) record so counters can accumulate.

    The durable record is a last-write-wins upsert in Mubit; without this
    read-modify-write, every feedback wiped the accumulated history and organic
    evidence capped at n=1. Strictly fail-open: any miss/error just starts a
    fresh history.
    """
    try:
        if tenant.durable_refs is not None:
            for ref in tenant.durable_refs.refs(lane, cluster, limit=64):
                if ref.model_id != model_id:
                    continue
                ev = await tenant.memory.dereference(
                    lane=lane, reference_id=ref.reference_id or ref.entry_id
                )
                if ev is not None and ev.record is not None:
                    return ev.record
                break
        hits = await tenant.memory.lookup(
            lane=lane,
            match=[{"kind": "outcome", "task_cluster": cluster, "model_id": model_id}],
            limit=4,
        )
        for ev in hits or []:
            if ev.record is not None:
                return ev.record
    except Exception as exc:  # noqa: BLE001 — accumulation is additive; never fail feedback
        log.warning("previous_record_read_failed", cluster=cluster, error=str(exc))
    return None


# Bound on relayed per-turn step outcomes (a plan rarely has more; a runaway
# harness must not turn one feedback into hundreds of Mubit writes).
STEP_OUTCOME_CAP = 32


async def _relay_step_outcomes(
    req: FeedbackRequest,
    memory: Memory,
    *,
    lane: str,
    user_id: str | None,
    warnings: list[str],
) -> int:
    """Relay per-step verdicts as Mubit process rewards. Strictly best-effort.

    Steps carry their own (gate) provenance, so they are relayed even when the
    turn-level outcome is unlabeled — a turn can be telemetry-only while its plan
    steps were deterministically verified.
    """
    if not req.step_outcomes:
        return 0
    dropped = len(req.step_outcomes) - STEP_OUTCOME_CAP
    if dropped > 0:
        warnings.append(f"step_outcomes_capped:{dropped}")
    recorded = 0
    for step in req.step_outcomes[:STEP_OUTCOME_CAP]:
        signal = step.signal if step.signal is not None else signal_from_outcome(
            step.outcome.value, None
        )
        try:
            await memory.record_step_outcome(
                lane=lane,
                step_id=step.step_id,
                outcome=step.outcome.value,
                signal=signal,
                step_name=step.step_name,
                rationale=step.rationale or f"minima feedback {req.recommendation_id}",
                directive_hint=step.directive_hint,
                user_id=user_id,
                metadata={"recommendation_id": req.recommendation_id},
            )
            recorded += 1
        except Exception as exc:  # noqa: BLE001 — process rewards must never fail feedback
            log.warning("step_outcome_failed", step_id=step.step_id, error=str(exc))
    if recorded < len(req.step_outcomes[:STEP_OUTCOME_CAP]):
        warnings.append("step_outcomes_partial")
    return recorded


def _update_contextual_head(
    tenant: TenantContext, req: FeedbackRequest, quality: float | None, source: str, infra: bool
) -> None:
    """F1: fold a TRUSTED-label outcome into the chosen model's contextual head.

    Pop-once on rec_id inside the store, so replays never double-count. Strictly
    best-effort — head updates must never fail feedback.
    """
    if tenant.contextual is None or infra or source not in TRUSTED_LABEL_SOURCES:
        return
    try:
        tenant.contextual.update(
            req.recommendation_id,
            req.chosen_model_id,
            label_score(req.outcome.value, quality),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("contextual_update_failed", error=str(exc))


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
    # so org A cannot credit or poison org B's recommendation. Sync store reads run off
    # the event loop (sqlite/redis/postgres backends).
    stored = await threadpool.run(tenant.recstore.get, req.recommendation_id)
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
    corrected = _reconcile_decision(
        tenant, req, quality, EVIDENCE_NONE if infra else source, late=False
    )
    if corrected:
        warnings.append("decision_corrected")
    _record_preference_pair(
        tenant, req, stored.task_cluster, EVIDENCE_NONE if infra else source
    )
    _note_provider_snapshot(tenant, req)
    _record_label_signals(tenant, req)
    _update_contextual_head(tenant, req, quality, source, infra)

    if not labeled:
        # Telemetry only: an unjudged turn or an infrastructure fault says nothing about
        # model quality — it must never touch the durable (cluster, model) record,
        # neighbor reinforcement, or lessons. Realized cost/latency live in the
        # decision-log reconcile above. Step outcomes still relay: they carry their own
        # deterministic (gate) provenance independent of the turn label.
        steps_recorded = await _relay_step_outcomes(
            req, memory, lane=stored.lane, user_id=stored.user_id, warnings=warnings
        )
        warnings.append("infra_failure_telemetry_only" if infra else "unlabeled_telemetry_only")
        return FeedbackResponse(
            accepted=True, step_outcomes_recorded=steps_recorded, warnings=warnings
        )

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
        effort=req.chosen_effort,
        recommendation_id=req.recommendation_id,
        verified_in_production=verified,
        recorded_at=time.time(),
        signals=req.signals,
    )
    # Accumulate: fold this outcome into the durable record's counters/rings so the
    # upsert carries HISTORY, not just the latest outcome. A replayed rec_id returns
    # the previous record unchanged — skip the write and reinforcement entirely.
    prev = await _previous_record(
        tenant, stored.lane, stored.task_cluster, req.chosen_model_id
    )
    record = merged_outcome(prev, record)
    if record is prev:
        # Replayed rec_id: the step outcomes were already relayed on first delivery
        # (record_step_outcome has no idempotency key on the wire — skipping here is
        # the dedup).
        warnings.append("duplicate_feedback_ignored")
        return FeedbackResponse(accepted=True, warnings=warnings)
    steps_recorded = await _relay_step_outcomes(
        req, memory, lane=stored.lane, user_id=stored.user_id, warnings=warnings
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
        # Honest, class-specific label: an outage, an expired key, a rejected payload, and a
        # bug in our own write path are distinct — don't flatten them all to one string.
        # A non-Mubit exception is our bug (memory_write_bug), NOT an outage; error_type keeps
        # the disguise visible in the log.
        warning = classify_memory_error(exc) or "memory_write_bug"
        log.warning(
            "remember_outcome_failed",
            warning=warning,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return FeedbackResponse(accepted=False, warnings=[warning])

    # The upserted (cluster, model) record's id is stable across feedbacks and
    # dereferenceable — remember it for the exact-match recall fast path.
    if record_id and tenant.durable_refs is not None:
        try:
            tenant.durable_refs.upsert(
                stored.lane, stored.task_cluster, req.chosen_model_id, record_id, record_id
            )
        except Exception as exc:  # noqa: BLE001 — bookkeeping must never fail feedback
            log.warning("durable_ref_upsert_failed", error=str(exc))

    # Reinforcement id spaces: entry_ids must be control-plane fact UUIDs. Keyed-lookup
    # neighbors carry a numeric core-plane node id as entry_id — substitute their fact
    # UUID reference when present, else the vote is unlandable and dropped. The primary
    # reference is the durable record we just upserted (guaranteed resolvable); one bad
    # neighbor ref must never sink the whole reinforcement call.
    neighbors = stored.neighbors_by_model.get(req.chosen_model_id, [])
    seen: set[str] = set()
    entry_ids: list[str] = []
    for eid, ref in neighbors:
        candidate = (ref or "") if (eid or "").isdigit() else (eid or "")
        if candidate and candidate not in seen:
            seen.add(candidate)
            entry_ids.append(candidate)
    primary_ref = record_id or next((ref for (_eid, ref) in neighbors if ref), None)

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
            # F3: reinforcement credit — every entry the outcome reinforced earns a
            # utility credit in this lane (best-effort, in-memory).
            if tenant.recall_utility is not None:
                for eid in entry_ids:
                    tenant.recall_utility.credit(stored.lane, eid)
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

    # Recall-track (free quality labels): this trusted-label outcome is a quality vote on
    # every durable record that was recalled into the decision — success reinforces their
    # track record, failure erodes it (experience-following countermeasure). Partial
    # outcomes abstain (neither a clean success nor a clean failure of the recalled
    # evidence). Strictly best-effort and bounded (RECALL_VOTE_CAP writes max).
    if req.outcome != OutcomeLabel.partial and settings.minima_recall_vote_min_n > 0:
        await _apply_recall_votes(
            tenant,
            settings,
            lane=stored.lane,
            neighbors=neighbors,
            current_record_id=record_id,
            success=is_success,
            idem=idem,
            user_id=stored.user_id,
            env_tags=stored.env_tags or None,
        )

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
        step_outcomes_recorded=steps_recorded,
        warnings=warnings,
    )


async def _apply_recall_votes(
    tenant: TenantContext,
    settings: Settings,
    *,
    lane: str,
    neighbors: list[tuple[str, str | None]],
    current_record_id: str | None,
    success: bool,
    idem: str,
    user_id: str | None,
    env_tags: list[str] | None,
) -> None:
    """Read-modify-write recall counters onto each recalled durable record.

    Same dereference→fold→upsert shape as the merged_outcome accumulation. The record
    just upserted by THIS feedback is skipped — it received the outcome as a direct
    observation; a recall vote on top would double-count it. A record whose track
    record crosses the invalidation threshold gets its bi-temporal stamp here (logged
    as memory_invalidated). Every failure is swallowed — votes are additive hygiene,
    never worth failing feedback over.

    F4a: a FAILED outcome's vote carries ``minima_recall_vote_failure_weight`` (default
    1.0 — legacy behavior); evidence that preceded a verified failure erodes faster
    than evidence that merely went unused.
    """
    vote_weight = 1.0 if success else settings.minima_recall_vote_failure_weight
    for i, (eid, ref) in enumerate(neighbors[:RECALL_VOTE_CAP]):
        # Dereference wants a durable reference id; a numeric core-plane node id is not
        # resolvable, so such neighbors only count when they carry a reference.
        target = ref or ("" if (eid or "").isdigit() else eid or "")
        if not target or target == current_record_id:
            continue
        try:
            ev = await tenant.memory.dereference(lane=lane, reference_id=target)
            if ev is None or ev.record is None or ev.record.invalidated_at is not None:
                continue
            voted = fold_recall_vote(ev.record, success, vote_weight)
            if should_invalidate(
                voted,
                min_n=settings.minima_recall_vote_min_n,
                max_rate=settings.minima_recall_invalidate_rate,
            ):
                voted.invalidated_at = time.time()
                log.info(
                    "memory_invalidated",
                    cluster=voted.task_cluster,
                    model_id=voted.model_id,
                    recall_n=voted.recall_n,
                    recall_success_mass=voted.recall_success_mass,
                )
            await tenant.memory.remember_outcome(
                content=ev.content,
                record=voted,
                lane=lane,
                upsert_key=outcome_upsert_key(voted.task_cluster, voted.model_id),
                idempotency_key=f"rv:{idem}:{i}",
                user_id=user_id,
                env_tags=env_tags,
                importance="low",
                source="human",
            )
            # F3: an invalidation-direction (failure) vote debits the entry's utility.
            if not success and tenant.recall_utility is not None:
                tenant.recall_utility.debit(lane, target, vote_weight)
        except Exception as exc:  # noqa: BLE001 — votes must never fail feedback
            log.warning("recall_vote_failed", target=target, error=str(exc))


def _note_provider_snapshot(tenant: TenantContext, req: FeedbackRequest) -> None:
    """Track the provider-reported model snapshot; a change stamps a posterior reset
    (version churn: evidence gathered against the old snapshot no longer describes
    the deployed model). Best-effort bookkeeping — never fails feedback."""
    if tenant.resets is None or not req.provider_model_snapshot:
        return
    try:
        if tenant.resets.note_snapshot(req.chosen_model_id, req.provider_model_snapshot):
            log.info(
                "posterior_reset_snapshot_change",
                model_id=req.chosen_model_id,
                snapshot=req.provider_model_snapshot,
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("snapshot_note_failed", error=str(exc))


def _reconcile_decision(
    tenant: TenantContext,
    req: FeedbackRequest,
    quality: float | None,
    evidence_source: str,
    *,
    late: bool,
) -> bool:
    """Fill the decision-log row's realized columns (best-effort analytics).

    Quality is strictly what the caller supplied — a label-based default is never
    substituted (it would corrupt calibration and OPE). evidence_source lets every
    reader (calibration fit, ECE, CUSUM) filter to trusted labels.

    Returns True when this feedback CORRECTED an already-reconciled row for the same
    realized model (a trusted label replacing stored untrusted telemetry) — surfaced
    to the caller as the decision_corrected warning.
    """
    if tenant.decision_log is None:
        return False
    try:
        prior = tenant.decision_log.get(req.recommendation_id)
        already_reconciled = (
            prior is not None
            and prior.reconciled
            and prior.realized_model_id == req.chosen_model_id
        )
        applied = tenant.decision_log.reconcile(
            req.recommendation_id,
            Reconciliation(
                model_id=req.chosen_model_id,
                outcome=req.outcome.value,
                quality=quality,
                cost_usd=req.actual_cost_usd,
                latency_ms=req.latency_ms,
                output_tokens=req.output_tokens,
                ts=time.time(),
                late=late,
                evidence_source=evidence_source,
                chosen_effort=req.chosen_effort,
                parent_rec_id=req.parent_rec_id,
                escalation_reason=req.escalation_reason,
                provider_model_snapshot=req.provider_model_snapshot,
                label_propensity=req.label_propensity,
            ),
        )
        return already_reconciled and applied
    except Exception as exc:  # noqa: BLE001 — analytics must never fail feedback
        log.warning("decision_reconcile_failed", error=str(exc))
        return False


def _record_preference_pair(
    tenant: TenantContext,
    req: FeedbackRequest,
    child_cluster: str,
    evidence_source: str,
) -> None:
    """Assemble a recovery-chain preference pair (best-effort, never fails feedback)."""
    if req.parent_rec_id is None or tenant.pair_store is None or tenant.decision_log is None:
        return
    try:
        parent = tenant.decision_log.get(req.parent_rec_id)
        if parent is None:
            return
        pair = assemble_pair(
            parent, req, child_cluster=child_cluster, child_evidence_source=evidence_source
        )
        if pair is not None:
            tenant.pair_store.put(pair)
            log.info(
                "preference_pair_recorded",
                cluster=pair.cluster,
                winner=pair.winner_model_id,
                loser=pair.loser_model_id,
                evidence=pair.evidence,
            )
    except Exception as exc:  # noqa: BLE001 — pair assembly must never fail feedback
        log.warning("preference_pair_failed", parent_rec_id=req.parent_rec_id, error=str(exc))


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
    corrected = _reconcile_decision(
        tenant, req, quality, EVIDENCE_NONE if infra else source, late=True
    )
    if corrected:
        warnings.append("decision_corrected")
    _record_preference_pair(tenant, req, decision.cluster, EVIDENCE_NONE if infra else source)
    _note_provider_snapshot(tenant, req)
    _record_label_signals(tenant, req)
    _update_contextual_head(tenant, req, quality, source, infra)

    if not labeled:
        steps_recorded = await _relay_step_outcomes(
            req, tenant.memory, lane=decision.lane, user_id=decision.user_id, warnings=warnings
        )
        warnings.append("infra_failure_telemetry_only" if infra else "unlabeled_telemetry_only")
        return FeedbackResponse(
            accepted=True, step_outcomes_recorded=steps_recorded, warnings=warnings
        )

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
        effort=req.chosen_effort,
        recommendation_id=req.recommendation_id,
        verified_in_production=source == EVIDENCE_GATE,
        recorded_at=time.time(),
        signals=req.signals,
    )
    prev = await _previous_record(tenant, decision.lane, decision.cluster, req.chosen_model_id)
    record = merged_outcome(prev, record)
    if record is prev:
        warnings.append("duplicate_feedback_ignored")
        return FeedbackResponse(accepted=True, warnings=warnings)
    steps_recorded = await _relay_step_outcomes(
        req, tenant.memory, lane=decision.lane, user_id=decision.user_id, warnings=warnings
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
        warning = classify_memory_error(exc) or "memory_write_bug"
        log.warning(
            "late_remember_outcome_failed",
            warning=warning,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return FeedbackResponse(accepted=False, warnings=[warning, *warnings])

    return FeedbackResponse(
        accepted=True,
        record_id=record_id,
        step_outcomes_recorded=steps_recorded,
        warnings=warnings,
    )
