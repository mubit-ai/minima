"""The recommendation orchestrator."""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass, field

from minima.catalog import probe
from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.logging import get_logger
from minima.memory import threadpool
from minima.memory.adapter import Memory
from minima.memory.keys import build_content, task_fingerprint, versioned_cluster
from minima.memory.recall_utility import RecallUtilityStore, apply_recall_utility
from minima.memory.records import RecalledEvidence, label_score
from minima.metrics.calibration import CalibratorSet, cusum_flags, fit_calibrators
from minima.recommender import contextual, escalation, score
from minima.recommender.aggregate import aggregate_by_model
from minima.recommender.classify import CLASSIFIER_ID, classify_details
from minima.recommender.contextual import ContextualStore
from minima.recommender.decisionlog import CandidateSnapshot, DecisionLog, DecisionRecord
from minima.recommender.durablerefs import DurableRefs
from minima.recommender.labelmodel import (
    FeedbackSignals,
    SignalCache,
    fit_lane_label_scores,
)
from minima.recommender.pairs import PairStore, pair_prior_adjustment
from minima.recommender.recstore import RecStore, StoredRecommendation
from minima.recommender.resets import CAUSE_CUSUM, ResetRegistry
from minima.recommender.types import CandidateScore, ModelAggregate
from minima.schemas.common import DecisionBasis, Difficulty, TaskType
from minima.schemas.models_catalog import ModelCard
from minima.schemas.recommend import (
    EvidenceRef,
    RankedModel,
    RecommendRequest,
    RecommendResponse,
)

log = get_logger("minima.recommender")

# Any positive recalled-outcome mass makes a candidate's prediction "memory-driven";
# the confidence field separately conveys how strong that evidence is.
MEMORY_WEIGHT_MIN = 0.0
# Half-life forced onto the "discounted" shadow challenger when the org has the
# production discount disabled (mirrors the minima_aggregate_half_life_days default).
_SHADOW_DISCOUNT_HALF_LIFE_DAYS = 45.0
# Max neighbors echoed back per candidate in the explained response.
MAX_EVIDENCE_PER_CANDIDATE = 5


class NoCandidatesError(ValueError):
    """Raised when constraints eliminate every catalog model."""


@dataclass(slots=True)
class _StageProfiler:
    started: float = field(default_factory=time.monotonic)
    marks: list[tuple[str, float]] = field(default_factory=list)

    def mark(self, name: str) -> None:
        self.marks.append((name, (time.monotonic() - self.started) * 1000.0))

    def as_dict(self) -> dict[str, float]:
        result: dict[str, float] = {}
        prev = 0.0
        for name, total in self.marks:
            result[name] = round(total - prev, 3)
            prev = total
        result["total"] = round((time.monotonic() - self.started) * 1000.0, 3)
        return result


class Recommender:
    def __init__(
        self,
        settings: Settings,
        memory: Memory,
        catalog_store: CatalogStore,
        recstore: RecStore,
        decision_log: DecisionLog | None = None,
        org_id: str = "default",
        rng: random.Random | None = None,
        durable_refs: DurableRefs | None = None,
        pair_store: PairStore | None = None,
        resets: ResetRegistry | None = None,
        contextual: ContextualStore | None = None,
        recall_utility: RecallUtilityStore | None = None,
    ):
        self._settings = settings
        self._memory = memory
        self._catalog_store = catalog_store
        self._recstore = recstore
        self._decision_log = decision_log
        self._org_id = org_id
        self._durable_refs = durable_refs
        self._pair_store = pair_store
        self._resets = resets
        self._contextual = contextual
        self._recall_utility = recall_utility
        self._rng = rng or random.Random()  # noqa: S311 — exploration sampling, not crypto
        argmin_orgs = {o.strip() for o in settings.minima_argmin_orgs.split(",") if o.strip()}
        self._thompson_enabled = (
            settings.minima_selection_policy.strip().lower() == "thompson"
            and org_id not in argmin_orgs
        )
        # Running exploration-share counters for the per-org deviation cap (in-process;
        # reset on restart — the cap bounds a burst, not lifetime spend).
        self._explore_picks = 0
        self._total_picks = 0
        # Lazily-fit, cached calibrator (org-scoped via this Recommender's decision log).
        self._calibrators: CalibratorSet | None = None
        self._calibrators_fitted_at: float = 0.0
        # Lazily-computed, cached per-cluster deferral stats (same refresh cadence as
        # the calibrator — both are windowed scans over this org's decision rows).
        self._deferral_stats: dict[str, tuple[int, int]] = {}
        self._deferral_fitted_at: float = 0.0
        # Weak-supervision label model (MINIMA_LABEL_MODEL): per-lane rec_id -> p_success,
        # fit lazily over the calibration window and cached on the same refresh cadence.
        # The signal cache holds the feedback facts (implicit signals, step summary,
        # iterations) the decision log deliberately does not carry.
        self._label_scores: dict[str, dict[str, float]] = {}
        self._label_scores_fitted_at: dict[str, float] = {}
        self._signal_cache = SignalCache()

    async def recommend(self, req: RecommendRequest) -> RecommendResponse:
        started = time.monotonic()
        profile = _StageProfiler(started=started)
        settings = self._settings
        warnings: list[str] = []

        classification = classify_details(req.task)
        # classify_details always populates `profile`; bind it locally so the type
        # checker sees a non-None ClassificationProfile (narrowing on the attribute
        # is otherwise dropped across the awaits below). Mutations still apply to the
        # same object, so behavior is unchanged.
        class_profile = classification.profile
        assert class_profile is not None
        task_type = classification.task_type
        difficulty = classification.difficulty
        profile.mark("classify")
        class_profile.final_task_type = task_type
        class_profile.final_difficulty = difficulty
        cluster = versioned_cluster(task_type, difficulty, settings.minima_cluster_key_version)
        fingerprint = task_fingerprint(req.task.task)
        lane = settings.lane(req.namespace)

        catalog = self._catalog_store.get()
        candidates = _select_candidates(catalog.cards, req, task_type, req.max_candidates)
        profile.mark("select_candidates")
        if not candidates:
            raise NoCandidatesError("no models match the supplied constraints")
        candidate_ids = {c.model_id for c in candidates}

        (
            recall,
            fastpath_evidence,
            lookup_degraded,
            legacy_weights,
        ) = await self._recall_with_fastpath(
            req=req,
            lane=lane,
            cluster=cluster,
            candidate_ids=candidate_ids,
            task_type=task_type,
            difficulty=difficulty,
        )
        profile.mark("recall")
        if recall.timed_out:
            warnings.append("recall_timeout")
        elif recall.error:
            # Class-specific label (memory_unreachable / _auth_failed / _rejected_payload /
            # _server_error / _recall_bug) so an outage isn't confused with an auth or schema
            # failure. Falls back to the legacy generic label if none was classified.
            warnings.append(recall.warning or "memory_unavailable")
        if lookup_degraded:
            # The deterministic per-(cluster, model) evidence channel is down (timeout,
            # transport error, or hosted policy) — the decision rests on ANN recall
            # alone. Surfaced so degraded evidence is never silent again.
            warnings.append("keyed_lookup_degraded")
        # Mubit's DriftMonitor flags ride the recall response for free. They are
        # diagnostics, never routing inputs: the harness recovery ladder (which owns
        # the cascade) hears that this lane is looping or on a failure streak before
        # its own budget ledger would notice.
        if recall.drift_repeated:
            warnings.append("memory_drift:repeated")
        if recall.drift_stagnant:
            warnings.append("memory_drift:stagnant")
        evidence = recall.outcome_evidence + fastpath_evidence

        # Neighbor-vote refinement: if the heuristic couldn't place the task confidently
        # (type `other`, or confidence below the gate), let the ANN-recalled semantic
        # neighbors vote and re-classify with them — type AND difficulty re-inferred
        # coherently (free; the cluster key then becomes coherent for scoring + the
        # stored outcome). Caller-supplied types win.
        if (
            req.task.task_type is None
            and settings.minima_neighbor_classify
            and evidence
            and (
                task_type == TaskType.other
                or classification.confidence < settings.minima_neighbor_classify_confidence
            )
        ):
            refined = classify_details(
                req.task,
                neighbor_votes=[
                    (ev.record.task_type, ev.score) for ev in evidence if ev.record is not None
                ],
            )
            if refined.neighbor_count > 0:
                classification = refined
                class_profile = refined.profile
                assert class_profile is not None
                task_type = refined.task_type
                difficulty = refined.difficulty
                cluster = versioned_cluster(
                    task_type, difficulty, settings.minima_cluster_key_version
                )
                warnings.append("neighbor_classified")
        profile.mark("neighbor_classify")

        # Remember durable-record ids surfaced by recall so the fast path (and the
        # feedback read-modify-write) can Dereference them next time. Only records
        # carrying accumulated counters qualify — they are unambiguously the durable
        # (cluster, model) upsert; a legacy per-row outcome or seed sharing the same
        # (cluster, model) must never clobber the ref feedback itself stored.
        # Bookkeeping only: a store failure must never break the recommendation.
        if self._durable_refs is not None:
            try:
                for ev in recall.outcome_evidence:
                    rec = ev.record
                    if (
                        rec is not None
                        and rec.task_cluster == cluster
                        and rec.source_dataset is None
                        and rec.n_outcomes > 0
                        and (ev.reference_id or ev.referenceable)
                    ):
                        self._durable_refs.upsert(
                            lane, cluster, rec.model_id, ev.entry_id, ev.reference_id or ""
                        )
            except Exception as exc:  # noqa: BLE001
                log.warning("durable_ref_upsert_failed", error=str(exc))
        profile.mark("durable_refs")

        # Refresh the calibrator OFF the event loop before scoring needs it (the lazy
        # refit scans the decision-log window — a sync DB read that must not stall the
        # loop). _score_candidates then reads the warm cache synchronously.
        await threadpool.run(self._get_calibrators)
        label_scores = (
            await threadpool.run(self._get_label_scores, lane)
            if settings.minima_label_model
            else None
        )
        # Recall-track: invalidated records (tombstoned by their recall track record) are
        # surfaced as a warning, then excluded from ranking (aggregate_by_model skips them
        # too — the count here is the diagnostic).
        n_invalidated = sum(
            1 for ev in evidence if ev.record is not None and ev.record.invalidated_at is not None
        )
        if n_invalidated:
            warnings.append(f"recall_invalidated_skipped:{n_invalidated}")
        reset_epochs: dict[str, float] | None = None
        if self._resets is not None:
            reset_epochs = {
                mid: epoch
                for mid in candidate_ids
                if (epoch := self._resets.epoch_for(mid, lane, cluster)) is not None
            } or None
        # Discounted+reset posteriors change the LIVE pick, so they apply only behind the
        # opt-in flag; the shadow "discounted" challenger below always sees them, which is
        # how an org measures the counterfactual before enabling. Reset stamping (CUSUM,
        # provider snapshots) continues regardless — history is ready when the flag flips.
        discounting = settings.minima_posterior_discounting
        # F3 (flag-gated): learned per-entry utility re-weights each evidence row's
        # similarity BEFORE aggregation — evidence-level, never a candidate re-rank.
        # In-place mutation, so the shadow challengers aggregate the SAME re-weighted
        # evidence and differ from production only by the discount.
        if settings.minima_recall_utility and self._recall_utility is not None and evidence:
            apply_recall_utility(evidence, lane, self._recall_utility)
        aggregates = aggregate_by_model(
            evidence,
            candidate_ids,
            half_life_days=settings.minima_evidence_half_life_days,
            decay_floor=settings.minima_evidence_decay_floor,
            seed_weight=settings.minima_seed_weight,
            seed_crowdout_n=settings.minima_seed_crowdout_n,
            recall_vote_min_n=settings.minima_recall_vote_min_n,
            human_weight=settings.minima_human_evidence_weight,
            discount_half_life_days=(
                settings.minima_aggregate_half_life_days if discounting else 0.0
            ),
            reset_epochs=reset_epochs if discounting else None,
            label_model_scores=label_scores,
            extra_weights=legacy_weights or None,
        )
        profile.mark("aggregate")

        input_tokens = req.task.expected_input_tokens or settings.minima_default_input_tokens
        output_tokens = req.task.expected_output_tokens or int(
            settings.minima_default_output_tokens
            * settings.minima_difficulty_output_multipliers.get(difficulty.value, 1.0)
        )
        scored = self._score_candidates(
            candidates, aggregates, task_type, input_tokens, output_tokens, req, cluster
        )
        profile.mark("score")
        # Premium counterfactual baseline, captured BEFORE the cost/latency filters
        # shrink the set — otherwise the baseline itself would shift with the caller's
        # constraints and savings would not be comparable across requests.
        est_cost_premium = max((c.est_cost_usd for c in scored), default=0.0)

        if req.constraints.max_cost_per_call is not None:
            affordable = [c for c in scored if c.est_cost_usd <= req.constraints.max_cost_per_call]
            if affordable:
                scored = affordable
            else:
                # max_cost_per_call is a hard filter: if no model fits the budget the
                # eligible set is empty, which is the same "nothing fits" condition as an
                # impossible candidate/exclusion set — surface it as the same 422 instead
                # of serving an over-budget model.
                raise NoCandidatesError("no model within max_cost_per_call budget")

        if req.constraints.max_latency_ms is not None:
            # Only exclude candidates with OBSERVED latency evidence above the budget —
            # a model is never condemned without data (its est_latency_ms stays None).
            within = [
                c
                for c in scored
                if c.est_latency_ms is None or c.est_latency_ms <= req.constraints.max_latency_ms
            ]
            if within:
                scored = within
            else:
                warnings.append("no_model_within_latency_budget")
        profile.mark("filters")

        tau = score.threshold_from_slider(
            req.cost_quality_tradeoff,
            settings.minima_tau_min,
            settings.minima_tau_max,
            req.constraints.min_quality,
        )

        recommended, fallback, ranked, opt_warnings = self._finalize(
            scored, tau, req.cost_quality_tradeoff
        )
        profile.mark("finalize")
        overall_basis = recommended.decision_basis
        # The deterministic cheapest-clearing-tau pick BEFORE any Thompson override —
        # logged as the "raw_argmin" shadow challenger.
        raw_argmin_id = recommended.card.model_id

        esc = escalation.evaluate(
            settings=settings,
            allow=req.allow_llm_escalation,
            total_weight=sum(a.weight_sum for a in aggregates.values()),
            distinct_models_with_evidence=sum(1 for a in aggregates.values() if a.weight_sum > 0),
            recommended_confidence=recommended.confidence,
            ranked=ranked,
            aggregates=aggregates,
            recall_confidence=recall.raw_confidence,
        )
        profile.mark("escalation_eval")
        # Escalation is DIAGNOSTIC only: thin/conflicting evidence is surfaced to the
        # caller (and the decision log), whose harness owns the honest cascade — the
        # recovery ladder re-decides after a VERIFIED failure. The old pre-decision
        # LLM reasoner (guess-before-running) was deleted: cascade-on-evidence
        # strictly dominates it and it shipped unreachable in the prod image anyway.
        if esc.should_escalate:
            warnings.extend(f"escalation_suggested:{reason}" for reason in esc.reasons)
        deferral = escalation.deferral_warning(
            await threadpool.run(self._get_deferral_stats),
            cluster,
            warn_rate=settings.minima_deferral_warn_rate,
            min_chains=settings.minima_deferral_min_chains,
        )
        if deferral:
            warnings.append(deferral)
        warnings.extend(opt_warnings)

        if not evidence:
            warnings.append("cold_start")
        if catalog.stale:
            warnings.append("prices_stale")

        # Selection policy: calibrated Thompson sampling is THE default — sample each
        # candidate's success from its Beta posterior, pick the cheapest clearing tau
        # under the sample. Self-tuning exploration (well-evidenced candidates behave
        # like argmin; uncertain ones get tried proportionally to plausibility) whose
        # Monte-Carlo selection frequencies ARE the logged propensities, so off-policy
        # evaluation is valid. "argmin" (per-org opt-out) keeps the deterministic
        # cheapest-clearing-tau pick with degenerate propensities.
        selection_policy = "argmin"
        explored_pick = False
        sel_propensities: dict[str, float] = dict.fromkeys((c.card.model_id for c in ranked), 0.0)
        sel_propensities[recommended.card.model_id] = 1.0
        # F1 (flag-gated): deterministic request-time context vector for the neural-linear
        # heads. Built from classifier outputs — recall evidence carries no embedding.
        context_x: list[float] | None = None
        if settings.minima_contextual_bandit and self._contextual is not None:
            context_x = contextual.context_vector(
                task_type,
                difficulty,
                input_tokens,
                output_tokens,
                class_profile.extracted_features,
                bool(req.task.tags),
            )
        if self._thompson_enabled and len(scored) >= 2:
            selection_policy = "thompson"
            if context_x is not None and self._contextual is not None:
                # Blended contextual Thompson: the sampled propensities of the BLENDED
                # draw are what gets logged — same honesty contract as thompson_select.
                cx_items = []
                for c in scored:
                    agg = aggregates.get(c.card.model_id)
                    n_cell = agg.weight_sum if agg is not None else 0.0
                    head_mean, head_std, _n = self._contextual.head_stats(
                        lane, c.card.model_id, context_x
                    )
                    cx_items.append(
                        (
                            c.card.model_id,
                            c.alpha,
                            c.beta,
                            c.est_cost_usd,
                            head_mean,
                            head_std,
                            contextual.blend_weight(n_cell),
                        )
                    )
                pick_id, pi = contextual.contextual_thompson_select(
                    cx_items, tau, self._rng, settings.minima_thompson_samples
                )
            else:
                items = [(c.card.model_id, c.alpha, c.beta, c.est_cost_usd) for c in scored]
                pick_id, pi = score.thompson_select(
                    items, tau, self._rng, settings.minima_thompson_samples
                )
            sel_propensities = dict.fromkeys((c.card.model_id for c in ranked), 0.0)
            sel_propensities.update(pi)
            if pick_id and pick_id != recommended.card.model_id:
                # Deviation cap: bound the running share of deliberate-exploration picks
                # so a cold pool can't route a burst of live traffic away from argmin.
                cap = settings.minima_explore_share_cap
                share = self._explore_picks / max(1, self._total_picks)
                if cap < 1.0 and share >= cap:
                    selection_policy = "argmin"
                    sel_propensities = dict.fromkeys(
                        (c.card.model_id for c in ranked), 0.0
                    )
                    sel_propensities[recommended.card.model_id] = 1.0
                    warnings.append("explore_budget_capped")
                else:
                    sampled = next((c for c in scored if c.card.model_id == pick_id), None)
                    if sampled is not None:
                        fallback = recommended  # the deterministic pick is the natural retry
                        recommended = sampled
                        overall_basis = recommended.decision_basis
                        explored_pick = True
                        warnings.append("thompson_pick")
        self._total_picks += 1
        if explored_pick:
            self._explore_picks += 1
        profile.mark("selection")

        shadow_choices = self._shadow_choices(
            evidence,
            candidate_ids,
            [c.card for c in scored],
            task_type,
            input_tokens,
            output_tokens,
            req,
            cluster,
            tau,
            reset_epochs,
            label_scores,
            raw_argmin_id,
        )

        recommendation_id = uuid.uuid4().hex
        stored_rec = StoredRecommendation(
                recommendation_id=recommendation_id,
                lane=lane,
                user_id=req.user_id,
                task_type=task_type.value,
                difficulty=difficulty.value,
                task_cluster=cluster,
                task_fingerprint=fingerprint,
                content=build_content(task_type.value, difficulty.value, req.task.task),
                env_tags=list(req.task.tags or []),
                recommended_model_id=recommended.card.model_id,
                neighbors_by_model={
                    mid: [(ev.entry_id, ev.reference_id) for ev in agg.evidence]
                    for mid, agg in aggregates.items()
                },
        )
        # Sync store I/O (sqlite/redis/postgres backends) runs off the event loop —
        # with --workers 1 an inline network write stalls every concurrent request.
        await threadpool.run(self._recstore.put, stored_rec)
        profile.mark("recstore")
        if context_x is not None and self._contextual is not None:
            try:
                self._contextual.note_context(recommendation_id, lane, context_x)
            except Exception as exc:  # noqa: BLE001 — bookkeeping must never break the hot path
                log.warning("contextual_note_failed", error=str(exc))
        await threadpool.run(
            self._log_decision,
            recommendation_id=recommendation_id,
            req=req,
            lane=lane,
            cluster=cluster,
            task_type=task_type,
            difficulty=difficulty,
            fingerprint=fingerprint,
            tau=tau,
            selection_policy=selection_policy,
            explored_pick=explored_pick,
            sel_propensities=sel_propensities,
            recommended=recommended,
            ranked=ranked,
            esc=esc,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            est_cost_premium=est_cost_premium,
            task_type_source=class_profile.task_type_source,
            shadow_choices=shadow_choices,
            classifier_id=CLASSIFIER_ID,
            cluster_key_version=settings.minima_cluster_key_version,
        )
        profile.mark("decision_log")

        confidence = _overall_confidence(overall_basis, recommended.confidence)
        profile.mark("response")
        return RecommendResponse(
            recommendation_id=recommendation_id,
            recommended_model=_to_ranked_model(recommended, req.explain),
            ranked=[_to_ranked_model(c, req.explain) for c in ranked],
            fallback_model=_to_ranked_model(fallback, req.explain) if fallback else None,
            confidence=round(confidence, 4),
            decision_basis=overall_basis,
            threshold_used=round(tau, 4),
            classified_task_type=task_type,
            classified_difficulty=difficulty,
            catalog_version=catalog.version,
            catalog_stale=catalog.stale,
            latency_ms=int((time.monotonic() - started) * 1000),
            classification_profile=classification.profile,
            warnings=warnings,
            selection_policy=selection_policy,
            recommended_actions=_actions_for(recommended.card),
            stage_latency_ms=profile.as_dict(),
            cluster_key_version=settings.minima_cluster_key_version,
        )

    async def _recall_with_fastpath(
        self,
        *,
        req: RecommendRequest,
        lane: str,
        cluster: str,
        candidate_ids: set[str],
        task_type: TaskType,
        difficulty: Difficulty,
    ):
        """ANN recall joined by a deterministic keyed lookup for the current cluster.

        The lookup (POST /v2/core/lookup) fetches outcome records for all candidate
        models in this cluster straight from storage — no ANN, no flicker. Records
        already returned by ANN are deduped by entry_id so they are never double-counted.
        Returns ``(recall, extra_evidence, lookup_degraded, legacy_weights)`` — the
        last maps legacy-key entry_ids to their aggregation discount.

        The old dereference-based fastpath (MINIMA_DURABLE_FASTPATH=on/shadow) is
        retained for backward compatibility and runs concurrently when configured.
        """
        settings = self._settings
        # Query with the SAME representation stored at write time (the classified
        # "[type/difficulty] gist" built by build_content) — outcome records were
        # embedded from that text, so querying with the raw prompt systematically
        # depressed similarity (prefix tokens on one side, truncation on the other).
        recall_coro = self._memory.recall(
            query=build_content(task_type.value, difficulty.value, req.task.task),
            lane=lane,
            user_id=req.user_id,
            limit=settings.minima_memory_recall_limit,
            env_tags=req.task.tags or None,
        )

        # Keyed lookup: one filter clause per candidate model in this cluster.
        # OR-combined on the server; returns all matching non-deleted records.
        # Dual-read window (PR-3): during a key-space migration the SAME single round
        # trip also matches the configured legacy-version keys — no second lookup, no
        # stacked timeout. Legacy rows are admitted per model only when the active-key
        # cell is thin, and at a discounted weight applied in aggregation.
        read_versions = [
            v.strip()
            for v in settings.minima_cluster_key_read_versions.split(",")
            if v.strip()
        ]
        legacy_keys = [
            key
            for v in read_versions
            if (key := versioned_cluster(task_type.value, difficulty.value, v)) != cluster
        ]
        lookup_coro = self._memory.lookup(
            lane=lane,
            match=[
                {"kind": "outcome", "task_cluster": key, "model_id": mid}
                for key in [cluster, *legacy_keys]
                for mid in candidate_ids
            ],
        )

        recall, lookup_evidence = await asyncio.gather(recall_coro, lookup_coro)
        lookup_degraded = lookup_evidence is None
        ann_ids = {ev.entry_id for ev in recall.evidence}
        extra = [ev for ev in lookup_evidence or [] if ev.entry_id not in ann_ids]
        legacy_weights: dict[str, float] = {}
        if legacy_keys:
            active_n: dict[str, int] = {}
            for ev in [*recall.evidence, *extra]:
                rec = ev.record
                if rec is not None and rec.task_cluster == cluster:
                    active_n[rec.model_id] = active_n.get(rec.model_id, 0) + 1
            kept: list[RecalledEvidence] = []
            for ev in extra:
                rec = ev.record
                if rec is None or rec.task_cluster == cluster:
                    kept.append(ev)
                    continue
                if active_n.get(rec.model_id, 0) >= settings.minima_dual_key_min_n:
                    continue
                legacy_weights[ev.entry_id] = settings.minima_legacy_evidence_weight
                kept.append(ev)
            extra = kept
        if extra:
            log.info(
                "keyed_lookup_delta",
                cluster=cluster,
                added=len(extra),
                legacy=len(legacy_weights),
                models=[ev.record.model_id for ev in extra if ev.record],
            )
        return recall, extra, lookup_degraded, legacy_weights

    def _log_decision(
        self,
        *,
        recommendation_id: str,
        req: RecommendRequest,
        lane: str,
        cluster: str,
        task_type: TaskType,
        difficulty: Difficulty,
        fingerprint: str,
        tau: float,
        selection_policy: str,
        explored_pick: bool,
        sel_propensities: dict[str, float],
        recommended: CandidateScore,
        ranked: list[CandidateScore],
        esc: escalation.EscalationDecision,
        input_tokens: int,
        output_tokens: int,
        est_cost_premium: float,
        task_type_source: str | None = None,
        shadow_choices: dict[str, str] | None = None,
        classifier_id: str | None = None,
        cluster_key_version: str | None = None,
    ) -> None:
        """Persist the decision row (best-effort — never breaks a recommendation)."""
        if self._decision_log is None:
            return
        # Counterfactual baselines on the same cost basis as the candidate set: premium =
        # the most expensive scored candidate BEFORE constraint filters (mirrors the
        # workflow endpoint's total_est_cost_if_all_premium); declared = the caller's
        # stated default model.
        baseline_cost: float | None = None
        if req.baseline_model_id:
            in_ranked = next((c for c in ranked if c.card.model_id == req.baseline_model_id), None)
            if in_ranked is not None:
                baseline_cost = in_ranked.est_cost_usd
            else:
                card = next(
                    (
                        m
                        for m in self._catalog_store.get().cards
                        if m.model_id == req.baseline_model_id
                    ),
                    None,
                )
                if card is not None:
                    baseline_cost = score.estimate_cost(card, input_tokens, output_tokens)[0]
        try:
            self._decision_log.put(
                DecisionRecord(
                    recommendation_id=recommendation_id,
                    org_id=self._org_id,
                    lane=lane,
                    cluster=cluster,
                    task_type=task_type.value,
                    difficulty=difficulty.value,
                    fingerprint=fingerprint,
                    ts=time.time(),
                    tau=tau,
                    policy=selection_policy,
                    epsilon=0.0,
                    chosen_model_id=recommended.card.model_id,
                    escalated=esc.should_escalate,
                    explored=explored_pick,
                    escalation_reasons=list(esc.reasons),
                    candidates=[
                        CandidateSnapshot(
                            model_id=c.card.model_id,
                            predicted_success=round(c.predicted_success, 6),
                            confidence=round(c.confidence, 6),
                            est_cost_usd=c.est_cost_usd,
                            propensity=round(sel_propensities.get(c.card.model_id, 0.0), 6),
                            raw_predicted_success=(
                                round(c.raw_predicted_success, 6)
                                if c.raw_predicted_success is not None
                                else None
                            ),
                            est_cost_low=c.est_cost_low,
                            est_cost_high=c.est_cost_high,
                        )
                        for c in ranked
                    ],
                    est_cost_recommended=recommended.est_cost_usd,
                    est_cost_premium=est_cost_premium,
                    baseline_model_id=req.baseline_model_id,
                    est_cost_baseline_declared=baseline_cost,
                    user_id=req.user_id,
                    env_tags=list(req.task.tags or []),
                    content=build_content(task_type.value, difficulty.value, req.task.task),
                    task_type_source=task_type_source,
                    task_type_confidence=req.task.task_type_confidence,
                    shadow_choices=shadow_choices,
                    classifier_id=classifier_id,
                    cluster_key_version=cluster_key_version,
                )
            )
        except Exception as exc:  # noqa: BLE001 — analytics must never break the hot path
            log.warning("decision_log_write_failed", error=str(exc))

    def _shadow_choices(
        self,
        evidence: list[RecalledEvidence],
        candidate_ids: set[str],
        cards: list[ModelCard],
        task_type: TaskType,
        input_tokens: int,
        output_tokens: int,
        req: RecommendRequest,
        cluster: str,
        tau: float,
        reset_epochs: dict[str, float] | None,
        label_scores: dict[str, float] | None,
        raw_argmin_id: str,
    ) -> dict[str, str]:
        """Would-have-chosen model ids for the shadow challenger policies.

        "raw_argmin" = the deterministic cheapest-clearing-tau pick (no Thompson).
        "discounted" = the same pick under scoring with the C2 discount forced on;
        when the discount is already active in production the two coincide, so the
        re-scoring pass only runs for orgs that disabled it. Pure CPU, best-effort."""
        settings = self._settings
        choices = {"raw_argmin": raw_argmin_id}
        if settings.minima_posterior_discounting and settings.minima_aggregate_half_life_days > 0.0:
            choices["discounted"] = raw_argmin_id
            return choices
        try:
            aggs = aggregate_by_model(
                evidence,
                candidate_ids,
                half_life_days=settings.minima_evidence_half_life_days,
                decay_floor=settings.minima_evidence_decay_floor,
                seed_weight=settings.minima_seed_weight,
                seed_crowdout_n=settings.minima_seed_crowdout_n,
                recall_vote_min_n=settings.minima_recall_vote_min_n,
                human_weight=settings.minima_human_evidence_weight,
                discount_half_life_days=_SHADOW_DISCOUNT_HALF_LIFE_DAYS,
                reset_epochs=reset_epochs,
                label_model_scores=label_scores,
            )
            scored = self._score_candidates(
                cards, aggs, task_type, input_tokens, output_tokens, req, cluster
            )
            pick, _, _, _ = _optimize(scored, tau)
            choices["discounted"] = pick.card.model_id
        except Exception as exc:  # noqa: BLE001 — shadow bookkeeping never breaks the pick
            log.warning("shadow_choice_failed", error=str(exc))
        return choices

    def _finalize(
        self, scored: list[CandidateScore], tau: float, cost_quality_tradeoff: float
    ) -> tuple[CandidateScore, CandidateScore | None, list[CandidateScore], list[str]]:
        max_cost = max((c.est_cost_usd for c in scored), default=0.0) or 1.0
        for c in scored:
            c.score = score.ranking_score(
                c.predicted_success, c.est_cost_usd / max_cost, cost_quality_tradeoff
            )
        return _optimize(scored, tau, self._settings.minima_cold_start_margin)


    # --------------------------------------------------------------- calibration
    def _calibrate(self, task_type_value: str, predicted: float) -> float:
        """Remap the raw Beta mean through the fitted calibrator (identity when unfit)."""
        cal = self._get_calibrators()
        if cal is None:
            return predicted
        return cal.transform(task_type_value, predicted)

    def _get_calibrators(self) -> CalibratorSet | None:
        settings = self._settings
        if not settings.minima_calibration_apply or self._decision_log is None:
            return None
        now = time.monotonic()
        if (
            self._calibrators is None
            or now - self._calibrators_fitted_at > settings.minima_calibration_refresh_seconds
        ):
            # Stamp BEFORE refit so concurrent requests for this org don't all refit at once.
            self._calibrators_fitted_at = now
            self._refit_calibrators()
        return self._calibrators

    def record_feedback_signals(
        self,
        rec_id: str,
        *,
        signals: dict[str, bool] | None,
        steps_all_success: bool | None,
        iterations: int | None,
    ) -> None:
        """Feedback-side intake for the label model's signal cache. No-op unless the
        flag is on; never raises past the caller's fail-open wrapper by construction."""
        if not self._settings.minima_label_model:
            return
        if signals is None and steps_all_success is None and iterations is None:
            return
        self._signal_cache.put(
            rec_id,
            FeedbackSignals(
                signals=dict(signals or {}),
                steps_all_success=steps_all_success,
                iterations=iterations,
            ),
        )

    def _get_label_scores(self, lane: str) -> dict[str, float] | None:
        settings = self._settings
        if not settings.minima_label_model or self._decision_log is None:
            return None
        now = time.monotonic()
        fitted_at = self._label_scores_fitted_at.get(lane)
        if (
            fitted_at is None
            or now - fitted_at > settings.minima_calibration_refresh_seconds
        ):
            # Stamp BEFORE the fit so concurrent requests don't all refit (same
            # single-flight shape as the calibrator refresh).
            self._label_scores_fitted_at[lane] = now
            try:
                since = time.time() - settings.minima_calibration_window_days * 86_400.0
                rows = self._decision_log.rows(since=since, lane=lane)
                self._label_scores[lane] = fit_lane_label_scores(
                    rows,
                    signals_by_rec=self._signal_cache.snapshot(),
                    surrogate_enabled=settings.minima_surrogate_index,
                )
            except Exception as exc:  # noqa: BLE001 — never break a recommendation
                log.warning("label_model_fit_failed", lane=lane, error=str(exc))
                self._label_scores.setdefault(lane, {})
        return self._label_scores.get(lane)

    def _refit_calibrators(self) -> None:
        """Refit from the org's reconciled decision rows (best-effort: keep prior on failure)."""
        settings = self._settings
        assert self._decision_log is not None
        try:
            since = time.time() - settings.minima_calibration_window_days * 86_400.0
            rows = self._decision_log.rows(since=since)
            self._calibrators = fit_calibrators(
                rows,
                min_n=settings.minima_calibration_min_n,
                shrinkage_k=settings.minima_calibration_shrinkage_k,
                now=time.time(),
            )
            # Piggyback drift detection on the same window scan: a CUSUM flag stamps a
            # posterior reset epoch for that (cluster, model). First stamp wins — the
            # flag persists across refits (it is computed over the same rows), and a
            # moving epoch would zero evidence forever.
            if self._resets is not None:
                for flag in cusum_flags(
                    rows, k=settings.minima_cusum_k, h=settings.minima_cusum_h
                ):
                    self._resets.stamp(
                        flag.model_id, cluster=flag.cluster, cause=CAUSE_CUSUM
                    )
        except Exception as exc:  # noqa: BLE001 — calibration must never break a recommendation
            log.warning("calibrator_refit_failed", error=str(exc))

    def _get_deferral_stats(self) -> dict[str, tuple[int, int]]:
        settings = self._settings
        if self._decision_log is None:
            return {}
        now = time.monotonic()
        if (
            not self._deferral_fitted_at
            or now - self._deferral_fitted_at > settings.minima_calibration_refresh_seconds
        ):
            self._deferral_fitted_at = now
            try:
                since = time.time() - settings.minima_calibration_window_days * 86_400.0
                self._deferral_stats = escalation.deferral_stats(
                    self._decision_log.rows(since=since)
                )
            except Exception as exc:  # noqa: BLE001 — diagnostics must never break the hot path
                log.warning("deferral_stats_failed", error=str(exc))
        return self._deferral_stats

    def _pair_win_rates(self, cluster: str) -> dict[tuple[str, str], tuple[int, int]] | None:
        if not self._settings.minima_pairs_enabled or self._pair_store is None:
            return None
        try:
            return self._pair_store.win_rates(cluster)
        except Exception as exc:  # noqa: BLE001 — pair evidence must never break scoring
            log.warning("pair_win_rates_failed", cluster=cluster, error=str(exc))
            return None

    def _score_candidates(
        self,
        candidates: list[ModelCard],
        aggregates: dict[str, ModelAggregate],
        task_type: TaskType,
        input_tokens: int,
        output_tokens: int,
        req: RecommendRequest,
        cluster: str,
    ) -> list[CandidateScore]:
        settings = self._settings
        scored: list[CandidateScore] = []
        min_cost_n = settings.minima_observed_cost_min_n
        # Decide the cost basis ONCE for the whole candidate set so all costs are compared
        # like-for-like (never mix per-request estimates with historical realized costs across
        # candidates). Prefers re-scaled observed output behavior (size-exact + reasoning-aware),
        # then robust observed $/call, else the cache-aware token estimate.
        cost_basis = score.choose_cost_basis(
            {c.model_id: aggregates.get(c.model_id) for c in candidates},
            settings.minima_use_observed_cost,
            req.constraints.require_prompt_caching,
            min_cost_n,
        )
        pair_rates = self._pair_win_rates(cluster)
        # F2 (flag-gated): the full catalog is the neighbor pool for probe cold start.
        probe_catalog = (
            self._catalog_store.get().cards if settings.minima_probe_cold_start else None
        )
        for card in candidates:
            agg = aggregates.get(card.model_id)
            prior = score.capability_prior(card, task_type)
            if probe_catalog is not None and card.capability_by_task_type.get(task_type) is None:
                cold = probe.cold_start_prior(card, task_type, probe_catalog)
                if cold is not None:
                    prior = cold
            if pair_rates:
                prior = pair_prior_adjustment(
                    prior,
                    card.model_id,
                    pair_rates,
                    min_n=settings.minima_pairs_min_n,
                    weight=settings.minima_pairs_weight,
                )
            predicted, confidence = score.predicted_success(
                agg, prior, settings.minima_beta_pseudocount
            )
            raw_predicted = predicted
            interval_width = score.posterior_interval_width(
                agg, prior, settings.minima_beta_pseudocount
            )
            alpha, beta = score.beta_params(agg, prior, settings.minima_beta_pseudocount)
            # Calibrate the honest Beta mean to a truthful probability. Deliberate
            # optimism is Thompson's job at selection time, not a score-time bonus.
            predicted = self._calibrate(task_type.value, predicted)
            use_cache = req.constraints.require_prompt_caching and card.supports_prompt_caching
            # The incumbent model keeps this session's prompt cache; a switch forfeits
            # it. Pricing part of the incumbent's input at the cache-read rate makes
            # stickiness fall out of honest cost accounting (estimate basis only —
            # observed/rescaled already reflect realized caching), keeping Thompson's
            # logged propensities valid instead of a post-hoc pick override.
            cache_fraction = (
                settings.minima_incumbent_cache_fraction
                if req.incumbent_model_id == card.model_id
                and card.supports_prompt_caching
                and not use_cache
                else 0.0
            )
            est_cost, breakdown = score.effective_cost(
                card,
                agg,
                input_tokens,
                output_tokens,
                use_cache,
                cost_basis,
                min_cost_n,
                cache_fraction,
            )
            cost_band = score.effective_cost_band(
                card, agg, input_tokens, use_cache, cost_basis, min_cost_n
            )
            est_cost_low, est_cost_high, cost_band_basis = (
                (cost_band[0][0], cost_band[0][1], cost_band[1])
                if cost_band is not None
                else (None, None, "")
            )
            cost_word = "obs" if ("observed_avg" in breakdown or "rescaled" in breakdown) else "est"
            est_latency = (
                agg.observed_latency_ms(
                    settings.minima_latency_min_n, settings.minima_latency_percentile
                )
                if agg is not None
                else None
            )

            if agg is not None and agg.weight_sum > MEMORY_WEIGHT_MIN:
                basis = DecisionBasis.memory
                rationale = (
                    f"{agg.n} similar past outcome(s); weighted success "
                    f"{agg.weighted_success_rate:.0%}; {cost_word} ${est_cost:.5f}/call"
                )
                evidence = agg.evidence[:MAX_EVIDENCE_PER_CANDIDATE]
            else:
                basis = DecisionBasis.prior
                rationale = (
                    f"no memory yet; capability prior {prior:.0%} for {task_type.value}; "
                    f"{cost_word} ${est_cost:.5f}/call"
                )
                evidence = agg.evidence[:MAX_EVIDENCE_PER_CANDIDATE] if agg else []

            scored.append(
                CandidateScore(
                    card=card,
                    predicted_success=predicted,
                    raw_predicted_success=raw_predicted,
                    confidence=confidence,
                    est_cost_usd=est_cost,
                    est_cost_breakdown=breakdown,
                    decision_basis=basis,
                    evidence=evidence,
                    rationale=rationale,
                    interval_width=interval_width,
                    alpha=alpha,
                    beta=beta,
                    est_latency_ms=est_latency,
                    latency_basis=(
                        f"observed_p{int(settings.minima_latency_percentile * 100)}"
                        if est_latency is not None
                        else ""
                    ),
                    est_cost_low=est_cost_low,
                    est_cost_high=est_cost_high,
                    cost_band_basis=cost_band_basis,
                )
            )
        return scored


def _actions_for(card: ModelCard) -> list[str]:
    """Near-free cost-saving actions the caller should apply to realize the quoted cost.

    Currently: prompt caching for models that support it (the harness applies it, so the
    realized cost reflects the cache discount). Batch mode is left to the caller's
    interactive/background signal and is not inferred here.
    """
    actions: list[str] = []
    if card.supports_prompt_caching:
        actions.append("enable_prompt_cache")
    return actions


def _overall_confidence(basis: DecisionBasis, recommended_confidence: float) -> float:
    if basis == DecisionBasis.memory:
        return recommended_confidence
    if basis == DecisionBasis.llm:
        return max(recommended_confidence, 0.5)
    return min(recommended_confidence, 0.5)


def _select_candidates(
    cards: list[ModelCard], req: RecommendRequest, task_type: TaskType, max_candidates: int
) -> list[ModelCard]:
    c = req.constraints
    selected = list(cards)
    if c.candidate_models:
        wanted = set(c.candidate_models)
        selected = [m for m in selected if m.model_id in wanted]
    if c.allowed_providers:
        allowed = {p.lower() for p in c.allowed_providers}
        selected = [m for m in selected if m.provider.lower() in allowed]
    if c.excluded_models:
        excluded = set(c.excluded_models)
        selected = [m for m in selected if m.model_id not in excluded]
    if c.require_prompt_caching:
        selected = [m for m in selected if m.supports_prompt_caching]
    if c.require_context_window:
        selected = [m for m in selected if m.context_window >= c.require_context_window]
    selected.sort(key=lambda m: score.capability_prior(m, task_type), reverse=True)
    return selected[:max_candidates]


def _optimize(
    scored: list[CandidateScore], tau: float, cold_start_margin: float = 0.0
) -> tuple[CandidateScore, CandidateScore | None, list[CandidateScore], list[str]]:
    """Deterministic MAP pick: cheapest candidate clearing tau, else highest-predicted.

    This is the argmin limit of the Thompson policy, which handles uncertainty-driven
    optimism natively at selection time (subsuming the old collapse-margin rescue,
    epsilon-softmax, and exploration-bonus mechanisms this replaced).

    ``cold_start_margin`` raises the eligibility bar to tau + margin for candidates whose
    prediction rests on pure catalog prior (decision_basis "prior" — zero evidence
    weight): a coarse prior scraping past tau must not win on price alone. Evidence-backed
    candidates are unaffected, and if the margin empties the eligible set, plain tau
    applies — the margin never causes the no-candidates failure path.
    """
    warnings: list[str] = []
    ranked = sorted(scored, key=lambda c: c.score, reverse=True)
    eligible = [c for c in scored if c.predicted_success >= tau]
    if cold_start_margin > 0.0 and eligible:
        margined = [
            c
            for c in eligible
            if c.decision_basis != DecisionBasis.prior
            or c.predicted_success >= tau + cold_start_margin
        ]
        if margined and len(margined) < len(eligible):
            eligible = margined
            warnings.append("cold_start_margin_applied")

    if eligible:
        recommended = min(
            eligible, key=lambda c: (c.est_cost_usd, -c.predicted_success, -c.confidence)
        )
    else:
        warnings.append("no_model_meets_threshold")
        recommended = max(scored, key=lambda c: c.predicted_success)

    others = [c for c in eligible if c.card.model_id != recommended.card.model_id]
    reliable = [c for c in others if c.predicted_success >= tau + 0.05]
    if reliable:
        fallback: CandidateScore | None = min(reliable, key=lambda c: c.est_cost_usd)
    else:
        rest = [c for c in ranked if c.card.model_id != recommended.card.model_id]
        fallback = max(rest, key=lambda c: c.predicted_success) if rest else None
    return recommended, fallback, ranked, warnings


def _to_ranked_model(c: CandidateScore, explain: bool) -> RankedModel:
    evidence = (
        [
            EvidenceRef(
                entry_id=ev.entry_id,
                reference_id=ev.reference_id,
                model_id=ev.record.model_id if ev.record else c.card.model_id,
                score=round(ev.score, 4),
                knowledge_confidence=round(ev.knowledge_confidence, 4),
                observed_success=(
                    round(label_score(ev.record.outcome, ev.record.quality_score), 4)
                    if ev.record
                    else 0.0
                ),
                is_stale=ev.is_stale,
            )
            for ev in c.evidence
        ]
        if explain
        else []
    )
    return RankedModel(
        model_id=c.card.model_id,
        provider=c.card.provider,
        predicted_success=round(c.predicted_success, 4),
        est_cost_usd=round(c.est_cost_usd, 8),
        est_cost_breakdown=c.est_cost_breakdown,
        score=round(c.score, 4),
        rationale=c.rationale,
        decision_basis=c.decision_basis,
        evidence=evidence,
        supports_prompt_caching=c.card.supports_prompt_caching,
        context_window=c.card.context_window,
        est_latency_ms=round(c.est_latency_ms, 1) if c.est_latency_ms is not None else None,
        latency_basis=c.latency_basis,
        est_cost_low=round(c.est_cost_low, 8) if c.est_cost_low is not None else None,
        est_cost_high=round(c.est_cost_high, 8) if c.est_cost_high is not None else None,
        cost_band_basis=c.cost_band_basis,
        success_interval_width=round(c.interval_width, 4),
    )
