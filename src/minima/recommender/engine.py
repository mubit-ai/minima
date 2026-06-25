"""The recommendation orchestrator."""

from __future__ import annotations

import asyncio
import math
import random
import time
import uuid

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.llm.base import CandidateView, Reasoner
from minima.logging import get_logger
from minima.memory.adapter import Memory
from minima.memory.keys import build_content, salient_signature, task_cluster, task_fingerprint
from minima.memory.records import clamp01
from minima.metrics.calibration import CalibratorSet, fit_calibrators
from minima.recommender import escalation, score
from minima.recommender.aggregate import aggregate_by_model, apply_ipw
from minima.recommender.classify import classify, classify_from_neighbors
from minima.recommender.decisionlog import CandidateSnapshot, DecisionLog, DecisionRecord
from minima.recommender.durablerefs import DurableRefs
from minima.recommender.propensity import Propensity, PropensityTracker
from minima.recommender.recstore import RecStore, StoredRecommendation
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
# Max neighbors echoed back per candidate in the explained response.
MAX_EVIDENCE_PER_CANDIDATE = 5


class NoCandidatesError(ValueError):
    """Raised when constraints eliminate every catalog model."""


class Recommender:
    def __init__(
        self,
        settings: Settings,
        memory: Memory,
        catalog_store: CatalogStore,
        recstore: RecStore,
        reasoner: Reasoner | None = None,
        propensity: Propensity | None = None,
        decision_log: DecisionLog | None = None,
        org_id: str = "default",
        rng: random.Random | None = None,
        durable_refs: DurableRefs | None = None,
    ):
        self._settings = settings
        self._memory = memory
        self._catalog_store = catalog_store
        self._recstore = recstore
        self._reasoner = reasoner
        self._propensity = propensity or PropensityTracker()
        self._decision_log = decision_log
        self._org_id = org_id
        self._durable_refs = durable_refs
        self._rng = rng or random.Random()  # noqa: S311 — exploration sampling, not crypto
        epsilon_orgs = {
            o.strip() for o in settings.minima_epsilon_selection_orgs.split(",") if o.strip()
        }
        self._epsilon_enabled = org_id in epsilon_orgs
        thompson_orgs = {
            o.strip() for o in settings.minima_thompson_selection_orgs.split(",") if o.strip()
        }
        self._thompson_enabled = org_id in thompson_orgs
        # Lazily-fit, cached calibrator (org-scoped via this Recommender's decision log).
        self._calibrators: CalibratorSet | None = None
        self._calibrators_fitted_at: float = 0.0

    async def recommend(self, req: RecommendRequest) -> RecommendResponse:
        started = time.monotonic()
        settings = self._settings
        warnings: list[str] = []

        task_type, difficulty = classify(req.task)
        task_type, difficulty = await self._maybe_llm_classify(req, task_type, difficulty, warnings)
        signature = (
            salient_signature(req.task.task, settings.minima_cluster_signature_tokens)
            if settings.minima_cluster_granularity.lower() == "fine"
            else None
        )
        cluster = task_cluster(task_type, difficulty, signature)
        fingerprint = task_fingerprint(req.task.task)
        lane = settings.lane(req.namespace)

        catalog = self._catalog_store.get()
        candidates = _select_candidates(catalog.cards, req, task_type, req.max_candidates)
        if not candidates:
            raise NoCandidatesError("no models match the supplied constraints")
        candidate_ids = {c.model_id for c in candidates}

        recall, fastpath_evidence = await self._recall_with_fastpath(
            req=req, lane=lane, cluster=cluster, candidate_ids=candidate_ids
        )
        if recall.timed_out:
            warnings.append("recall_timeout")
        elif recall.error:
            warnings.append("memory_unavailable")
        evidence = recall.outcome_evidence + fastpath_evidence

        # Neighbor-vote refinement: if the heuristic couldn't place the task, let the
        # ANN-recalled semantic neighbors vote on its type (free; the cluster key then
        # becomes coherent for scoring + the stored outcome). Caller-supplied types win.
        if (
            req.task.task_type is None
            and task_type == TaskType.other
            and settings.minima_neighbor_classify
            and evidence
        ):
            voted = classify_from_neighbors(
                [(ev.record.task_type, ev.score) for ev in evidence if ev.record is not None]
            )
            if voted is not None and voted != task_type:
                task_type = voted
                cluster = task_cluster(task_type, difficulty, signature)
                warnings.append("neighbor_classified")

        # Remember durable-record ids surfaced by recall so the fast path can
        # Dereference them next time (live records only — seeds are per-row inserts,
        # not the durable (cluster, model) upsert). Bookkeeping only: a store failure
        # must never break the recommendation.
        if self._durable_refs is not None:
            try:
                for ev in recall.outcome_evidence:
                    rec = ev.record
                    if (
                        rec is not None
                        and rec.task_cluster == cluster
                        and rec.source_dataset is None
                        and (ev.reference_id or ev.referenceable)
                    ):
                        self._durable_refs.upsert(
                            lane, cluster, rec.model_id, ev.entry_id, ev.reference_id or ""
                        )
            except Exception as exc:  # noqa: BLE001
                log.warning("durable_ref_upsert_failed", error=str(exc))

        aggregates = aggregate_by_model(
            evidence,
            candidate_ids,
            half_life_days=settings.minima_evidence_half_life_days,
            decay_floor=settings.minima_evidence_decay_floor,
            seed_weight=settings.minima_seed_weight,
            seed_crowdout_n=settings.minima_seed_crowdout_n,
        )
        if settings.minima_ipw_enabled and aggregates:
            apply_ipw(
                aggregates,
                self._propensity.propensities(lane, cluster, candidate_ids),
                settings.minima_ipw_clip_low,
                settings.minima_ipw_clip_high,
            )

        input_tokens = req.task.expected_input_tokens or settings.minima_default_input_tokens
        output_tokens = req.task.expected_output_tokens or int(
            settings.minima_default_output_tokens
            * settings.minima_difficulty_output_multipliers.get(difficulty.value, 1.0)
        )
        scored = self._score_candidates(
            candidates, aggregates, task_type, input_tokens, output_tokens, req
        )
        # Premium counterfactual baseline, captured BEFORE the cost/latency filters
        # shrink the set — otherwise the baseline itself would shift with the caller's
        # constraints and savings would not be comparable across requests.
        est_cost_premium = max((c.est_cost_usd for c in scored), default=0.0)

        if req.constraints.max_cost_per_call is not None:
            affordable = [c for c in scored if c.est_cost_usd <= req.constraints.max_cost_per_call]
            if affordable:
                scored = affordable
            else:
                warnings.append("no_model_within_cost_budget")

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

        tau = score.threshold_from_slider(
            req.cost_quality_tradeoff,
            settings.minima_tau_min,
            settings.minima_tau_max,
            req.constraints.min_quality,
        )

        recommended, fallback, ranked, opt_warnings = self._finalize(
            scored, tau, req.cost_quality_tradeoff
        )
        overall_basis = recommended.decision_basis

        esc = escalation.evaluate(
            settings=settings,
            allow=req.allow_llm_escalation,
            total_weight=sum(a.weight_sum for a in aggregates.values()),
            distinct_models_with_evidence=sum(1 for a in aggregates.values() if a.weight_sum > 0),
            recommended_confidence=recommended.confidence,
            ranked=ranked,
            aggregates=aggregates,
            recommended_interval_width=score.posterior_interval_width(
                aggregates.get(recommended.card.model_id),
                score.capability_prior(recommended.card, task_type),
                settings.minima_beta_pseudocount,
            ),
            recommended_predicted_success=recommended.predicted_success,
            tau=tau,
        )
        if esc.should_escalate:
            warnings.extend(f"escalation_suggested:{reason}" for reason in esc.reasons)
            if self._reasoner is not None and settings.reasoner_enabled:
                consulted = await self._consult_reasoner(
                    scored=scored, task_type=task_type, difficulty=difficulty, lane=lane, req=req
                )
                if consulted:
                    recommended, fallback, ranked, opt_warnings = self._finalize(
                        scored, tau, req.cost_quality_tradeoff
                    )
                    overall_basis = DecisionBasis.llm
                    warnings.append("reasoner_consulted")
                else:
                    warnings.append("reasoner_failed")
            else:
                warnings.append("reasoner_disabled")
        warnings.extend(opt_warnings)

        if not evidence:
            warnings.append("cold_start")
        if catalog.stale:
            warnings.append("prices_stale")

        # Selection policy: deterministic argmin everywhere; epsilon-softmax over the
        # tau-ELIGIBLE set for opted-in orgs (the safety floor is eligibility itself).
        # The propensity vector is logged either way so off-policy evaluation can tell
        # a degenerate (deterministic) log from a stochastic one.
        selection_policy = "argmin"
        explored_pick = False
        sel_propensities: dict[str, float] = dict.fromkeys(
            (c.card.model_id for c in ranked), 0.0
        )
        sel_propensities[recommended.card.model_id] = 1.0
        if self._thompson_enabled and len(scored) >= 2:
            # Posterior-sampling selection: sample each candidate's success, pick cheapest
            # clearing tau under the sample. MC frequencies are the logged propensities.
            selection_policy = "thompson"
            items = [(c.card.model_id, c.alpha, c.beta, c.est_cost_usd) for c in scored]
            pick_id, pi = score.thompson_select(
                items, tau, self._rng, settings.minima_thompson_samples
            )
            sel_propensities = dict.fromkeys((c.card.model_id for c in ranked), 0.0)
            sel_propensities.update(pi)
            if pick_id and pick_id != recommended.card.model_id:
                sampled = next((c for c in scored if c.card.model_id == pick_id), None)
                if sampled is not None:
                    fallback = recommended  # the deterministic pick is the natural retry
                    recommended = sampled
                    overall_basis = recommended.decision_basis
                    explored_pick = True
                    warnings.append("thompson_pick")
        elif self._epsilon_enabled:
            eligible = [c for c in ranked if c.predicted_success >= tau]
            if len(eligible) >= 2:
                selection_policy = "epsilon_softmax"
                argmin_id = recommended.card.model_id
                pi = score.softmax_propensities(
                    {c.card.model_id: c.score for c in eligible},
                    argmin_id,
                    settings.minima_epsilon,
                    settings.minima_epsilon_softmax_temperature,
                )
                sel_propensities.update(pi)
                sampled = self._maybe_explore(eligible, argmin_id)
                if sampled is not None and sampled.card.model_id != argmin_id:
                    fallback = recommended  # the deterministic pick is the natural retry
                    recommended = sampled
                    overall_basis = recommended.decision_basis
                    explored_pick = True
                    warnings.append("exploration_pick")

        self._propensity.record(lane, cluster, recommended.card.model_id)

        # Advisory shadow bandit: log what a UCB policy WOULD pick (never overrides).
        shadow_pick: str | None = None
        if settings.minima_shadow_bandit and ranked:
            shadow_pick = _shadow_pick(
                ranked, req.cost_quality_tradeoff, settings.minima_shadow_ucb_alpha
            )
            if shadow_pick is not None and shadow_pick != recommended.card.model_id:
                warnings.append("shadow_disagree")

        recommendation_id = uuid.uuid4().hex
        self._recstore.put(
            StoredRecommendation(
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
        )
        self._log_decision(
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
            shadow_chosen_model_id=shadow_pick,
        )

        confidence = _overall_confidence(overall_basis, recommended.confidence)
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
            warnings=warnings,
            selection_policy=selection_policy,
            recommended_actions=_actions_for(recommended.card),
        )

    def _maybe_explore(
        self, eligible: list[CandidateScore], argmin_id: str
    ) -> CandidateScore | None:
        """Sample the epsilon branch: softmax over eligible ranking scores.

        Returns the sampled candidate (possibly the argmin itself) or None when the
        (1 - epsilon) deterministic branch was taken.
        """
        settings = self._settings
        if self._rng.random() >= settings.minima_epsilon:
            return None
        t = max(settings.minima_epsilon_softmax_temperature, 1e-6)
        peak = max(c.score for c in eligible)
        weights = [math.exp((c.score - peak) / t) for c in eligible]
        return self._rng.choices(eligible, weights=weights, k=1)[0]

    async def _recall_with_fastpath(
        self,
        *,
        req: RecommendRequest,
        lane: str,
        cluster: str,
        candidate_ids: set[str],
    ):
        """ANN recall joined by a deterministic keyed lookup for the current cluster.

        The lookup (POST /v2/core/lookup) fetches outcome records for all candidate
        models in this cluster straight from storage — no ANN, no flicker. Records
        already returned by ANN are deduped by entry_id so they are never double-counted.

        The old dereference-based fastpath (MINIMA_DURABLE_FASTPATH=on/shadow) is
        retained for backward compatibility and runs concurrently when configured.
        """
        settings = self._settings
        recall_coro = self._memory.recall(
            query=req.task.task,
            lane=lane,
            user_id=req.user_id,
            limit=settings.minima_memory_recall_limit,
            env_tags=req.task.tags or None,
        )

        # Keyed lookup: one filter clause per candidate model in this cluster.
        # OR-combined on the server; returns all matching non-deleted records.
        lookup_coro = self._memory.lookup(
            lane=lane,
            match=[
                {"kind": "outcome", "task_cluster": cluster, "model_id": mid}
                for mid in candidate_ids
            ],
        )

        mode = settings.minima_durable_fastpath.lower()
        refs = (
            self._durable_refs.refs(lane, cluster, settings.minima_durable_fastpath_max_refs)
            if mode in ("shadow", "on") and self._durable_refs is not None
            else []
        )

        if not refs:
            # Fast common path: recall + lookup, no dereferences.
            recall, lookup_evidence = await asyncio.gather(recall_coro, lookup_coro)
            ann_ids = {ev.entry_id for ev in recall.evidence}
            extra = [ev for ev in lookup_evidence if ev.entry_id not in ann_ids]
            if extra:
                log.info(
                    "keyed_lookup_delta",
                    cluster=cluster,
                    added=len(extra),
                    models=[ev.record.model_id for ev in extra if ev.record],
                )
            return recall, extra

        # Old dereference fastpath active: run all three concurrently, share the
        # recall latency budget, then merge — lookup results deduped against both
        # ANN and dereference results so no evidence is double-counted.
        started = time.monotonic()
        budget_s = settings.minima_memory_recall_timeout_ms / 1000.0
        recall_task = asyncio.ensure_future(recall_coro)
        lookup_task = asyncio.ensure_future(lookup_coro)
        deref_tasks = [
            asyncio.ensure_future(
                self._memory.dereference(lane=lane, reference_id=r.reference_id or r.entry_id)
            )
            for r in refs
        ]
        recall = await recall_task
        lookup_evidence = await lookup_task
        remaining = max(0.05, budget_s - (time.monotonic() - started))
        done, pending = await asyncio.wait(deref_tasks, timeout=remaining)
        for task in pending:
            task.cancel()
        if pending:
            log.warning("durable_fastpath_timeout", cluster=cluster, dropped=len(pending))
        derefs = [
            task.result()
            for task in done
            if not task.cancelled() and task.exception() is None
        ]
        fetched = [d for d in derefs if d is not None and d.record is not None]
        ann_ids = {ev.entry_id for ev in recall.evidence}
        missed = [d for d in fetched if d.entry_id not in ann_ids]
        if missed:
            log.info(
                "durable_fastpath_delta",
                mode=mode,
                cluster=cluster,
                fetched=len(fetched),
                ann_missed=len(missed),
                missed_models=[d.record.model_id for d in missed if d.record],
            )
        deref_extra = missed if mode == "on" else []
        seen_ids = ann_ids | {ev.entry_id for ev in deref_extra}
        lookup_extra = [ev for ev in lookup_evidence if ev.entry_id not in seen_ids]
        if lookup_extra:
            log.info(
                "keyed_lookup_delta",
                cluster=cluster,
                added=len(lookup_extra),
                models=[ev.record.model_id for ev in lookup_extra if ev.record],
            )
        return recall, lookup_extra + deref_extra

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
        shadow_chosen_model_id: str | None = None,
    ) -> None:
        """Persist the decision row (best-effort — never breaks a recommendation)."""
        if self._decision_log is None:
            return
        settings = self._settings
        # Counterfactual baselines on the same cost basis as the candidate set: premium =
        # the most expensive scored candidate BEFORE constraint filters (mirrors the
        # workflow endpoint's total_est_cost_if_all_premium); declared = the caller's
        # stated default model.
        baseline_cost: float | None = None
        if req.baseline_model_id:
            in_ranked = next(
                (c for c in ranked if c.card.model_id == req.baseline_model_id), None
            )
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
                    epsilon=settings.minima_epsilon if selection_policy != "argmin" else 0.0,
                    chosen_model_id=recommended.card.model_id,
                    escalated=esc.should_escalate,
                    shadow_chosen_model_id=shadow_chosen_model_id,
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
                )
            )
        except Exception as exc:  # noqa: BLE001 — analytics must never break the hot path
            log.warning("decision_log_write_failed", error=str(exc))

    async def _maybe_llm_classify(
        self,
        req: RecommendRequest,
        task_type: TaskType,
        difficulty: Difficulty,
        warnings: list[str],
    ) -> tuple[TaskType, Difficulty]:
        """Refine an ambiguous heuristic classification via the reasoner (best-effort)."""
        if not (
            self._settings.minima_reasoner_classify
            and req.allow_llm_escalation
            and req.task.task_type is None
            and task_type == TaskType.other
            and self._reasoner is not None
            and self._settings.reasoner_enabled
            and hasattr(self._reasoner, "classify")
        ):
            return task_type, difficulty
        try:
            result = await self._reasoner.classify(task=req.task.task)
        except Exception as exc:  # noqa: BLE001
            log.warning("llm_classify_failed", error=str(exc))
            return task_type, difficulty
        if result is None:
            return task_type, difficulty
        warnings.append("llm_classified")
        return result

    async def _consult_reasoner(
        self,
        *,
        scored: list[CandidateScore],
        task_type: TaskType,
        difficulty: Difficulty,
        lane: str,
        req: RecommendRequest,
    ) -> bool:
        memory_block = await self._memory.get_context(
            query=req.task.task, lane=lane, user_id=req.user_id, max_token_budget=1500
        )
        views = [
            CandidateView(
                model_id=c.card.model_id,
                provider=c.card.provider,
                input_cost_per_mtok=c.card.input_cost_per_mtok,
                output_cost_per_mtok=c.card.output_cost_per_mtok,
                context_window=c.card.context_window,
                capability_prior=score.capability_prior(c.card, task_type),
                est_cost_usd=c.est_cost_usd,
                predicted_success=c.predicted_success,
                est_latency_ms=c.est_latency_ms,
            )
            for c in scored
        ]
        result = await self._reasoner.rank(  # type: ignore[union-attr]
            task=req.task.task,
            task_type=task_type.value,
            difficulty=difficulty.value,
            candidates=views,
            memory_block=memory_block,
            cost_quality_tradeoff=req.cost_quality_tradeoff,
        )
        if not result or not result.rankings:
            return False
        settings = self._settings
        rankings = result.by_model()
        changed = False
        for c in scored:
            ranking = rankings.get(c.card.model_id)
            if ranking is None:
                continue
            if settings.minima_reasoner_blend_adaptive:
                # Evidence-mass-adaptive: a candidate backed by heavy deterministic
                # evidence (confidence -> 1) barely moves toward the LLM's estimate; a
                # cold candidate (confidence -> 0) leans on it. Replaces the fixed blend
                # that weighted a 50-outcome aggregate and a guess identically.
                raw = settings.minima_reasoner_blend_max * (1.0 - c.confidence)
                blend = min(0.9, max(0.1, raw))
            else:
                blend = settings.minima_reasoner_blend
            c.predicted_success = clamp01(
                blend * ranking.predicted_success + (1.0 - blend) * c.predicted_success
            )
            c.decision_basis = DecisionBasis.llm
            if ranking.rationale:
                c.rationale = ranking.rationale
            changed = True
        return changed

    def _finalize(
        self, scored: list[CandidateScore], tau: float, cost_quality_tradeoff: float
    ) -> tuple[CandidateScore, CandidateScore | None, list[CandidateScore], list[str]]:
        max_cost = max((c.est_cost_usd for c in scored), default=0.0) or 1.0
        for c in scored:
            c.score = score.ranking_score(
                c.predicted_success, c.est_cost_usd / max_cost, cost_quality_tradeoff
            )
        return _optimize(scored, tau, self._settings.minima_collapse_margin)

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
        except Exception as exc:  # noqa: BLE001 — calibration must never break a recommendation
            log.warning("calibrator_refit_failed", error=str(exc))

    def _score_candidates(
        self,
        candidates: list[ModelCard],
        aggregates: dict[str, ModelAggregate],
        task_type: TaskType,
        input_tokens: int,
        output_tokens: int,
        req: RecommendRequest,
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
        for card in candidates:
            agg = aggregates.get(card.model_id)
            prior = score.capability_prior(card, task_type)
            predicted, confidence = score.predicted_success(
                agg, prior, settings.minima_beta_pseudocount
            )
            raw_predicted = predicted
            interval_width = score.posterior_interval_width(
                agg, prior, settings.minima_beta_pseudocount
            )
            alpha, beta = score.beta_params(agg, prior, settings.minima_beta_pseudocount)
            # Calibrate the honest Beta mean to a truthful probability BEFORE the
            # exploration bonus (deliberate optimism) is layered on for the tau decision.
            predicted = self._calibrate(task_type.value, predicted)
            predicted = score.with_exploration_bonus(
                predicted, confidence, settings.minima_exploration_bonus
            )
            use_cache = req.constraints.require_prompt_caching and card.supports_prompt_caching
            cache_fraction = (
                settings.minima_cost_cache_input_fraction
                if settings.minima_cost_lever_aware
                and card.supports_prompt_caching
                and not use_cache
                else 0.0
            )
            est_cost, breakdown = score.effective_cost(
                card, agg, input_tokens, output_tokens, use_cache, cost_basis, min_cost_n,
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


def _shadow_pick(
    scored: list[CandidateScore], cost_quality_tradeoff: float, alpha: float
) -> str | None:
    """The UCB shadow policy's pick (argmax ucb_score over the scored candidates)."""
    if not scored:
        return None
    max_cost = max((c.est_cost_usd for c in scored), default=0.0) or 1.0
    best = max(
        scored,
        key=lambda c: score.ucb_score(
            c.predicted_success, c.interval_width, c.est_cost_usd / max_cost,
            cost_quality_tradeoff, alpha,
        ),
    )
    return best.card.model_id


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
    scored: list[CandidateScore], tau: float, collapse_margin: float = 0.0
) -> tuple[CandidateScore, CandidateScore | None, list[CandidateScore], list[str]]:
    warnings: list[str] = []
    ranked = sorted(scored, key=lambda c: c.score, reverse=True)
    eligible = [c for c in scored if c.predicted_success >= tau]

    # Tau-aware optimism: the rescue shrinks as the quality bar rises, so at a HIGH
    # cost_quality setting (user wants quality) the guard barely fires, and at a LOW bar
    # (cost-leaning) it rescues cheap-but-uncertain models freely. This is what keeps the
    # guard from trading away quality exactly where the user asked for it.
    effective_margin = collapse_margin * max(0.0, 1.0 - tau)

    def _optimistic_clears(c: CandidateScore) -> bool:
        # Upper credible-bound view: predicted + effective_margin * half-width clears tau.
        # Only applied to candidates with ACTUAL evidence (confidence > 0) — at cold start,
        # capability priors (not optimism over a maximal interval) decide, so the guard is inert.
        if c.confidence <= 0.0:
            return False
        return c.predicted_success + effective_margin * 0.5 * c.interval_width >= tau

    if eligible:
        recommended = min(
            eligible, key=lambda c: (c.est_cost_usd, -c.predicted_success, -c.confidence)
        )
        # Routing-collapse guard: if the cheapest model clearing tau is ITSELF the priciest
        # candidate, prefer a cheaper candidate whose credible interval could still clear tau
        # (the judge/escalation loop catches an over-optimistic cheap pick).
        if collapse_margin > 0.0 and len(scored) > 1:
            max_cost = max(c.est_cost_usd for c in scored)
            if recommended.est_cost_usd >= max_cost - 1e-12:
                cheaper = [
                    c
                    for c in scored
                    if c.est_cost_usd < recommended.est_cost_usd and _optimistic_clears(c)
                ]
                if cheaper:
                    recommended = min(
                        cheaper,
                        key=lambda c: (c.est_cost_usd, -c.predicted_success, -c.confidence),
                    )
                    warnings.append("collapse_guard_applied")
    else:
        warnings.append("no_model_meets_threshold")
        # Don't default to the strongest (usually priciest) model: prefer the cheapest whose
        # optimistic upper bound could still clear tau, falling back to strongest if none.
        plausible = [c for c in scored if _optimistic_clears(c)] if collapse_margin > 0.0 else []
        if plausible:
            recommended = min(plausible, key=lambda c: (c.est_cost_usd, -c.predicted_success))
            warnings.append("collapse_guard_applied")
        else:
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
                observed_success=round(ev.record.quality_score, 4) if ev.record else 0.0,
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
