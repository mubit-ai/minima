"""The recommendation orchestrator."""

from __future__ import annotations

import time
import uuid

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.llm.base import CandidateView, Reasoner
from minima.logging import get_logger
from minima.memory.adapter import Memory
from minima.memory.keys import build_content, salient_signature, task_cluster, task_fingerprint
from minima.memory.records import clamp01
from minima.recommender import escalation, score
from minima.recommender.aggregate import aggregate_by_model, apply_ipw
from minima.recommender.classify import classify
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
    ):
        self._settings = settings
        self._memory = memory
        self._catalog_store = catalog_store
        self._recstore = recstore
        self._reasoner = reasoner
        self._propensity = propensity or PropensityTracker()

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
        env_tags = req.task.tags or None

        catalog = self._catalog_store.get()
        candidates = _select_candidates(catalog.cards, req, task_type, req.max_candidates)
        if not candidates:
            raise NoCandidatesError("no models match the supplied constraints")
        candidate_ids = {c.model_id for c in candidates}

        recall = await self._memory.recall(
            query=req.task.task,
            lane=lane,
            user_id=req.user_id,
            limit=settings.minima_memory_recall_limit,
            env_tags=env_tags,
        )
        if recall.timed_out:
            warnings.append("recall_timeout")
        elif recall.error:
            warnings.append("memory_unavailable")

        aggregates = aggregate_by_model(recall.outcome_evidence, candidate_ids)
        if settings.minima_ipw_enabled and aggregates:
            apply_ipw(
                aggregates,
                self._propensity.propensities(lane, cluster, candidate_ids),
                settings.minima_ipw_clip_low,
                settings.minima_ipw_clip_high,
            )

        input_tokens = req.task.expected_input_tokens or settings.minima_default_input_tokens
        output_tokens = req.task.expected_output_tokens or settings.minima_default_output_tokens
        scored = self._score_candidates(
            candidates, aggregates, task_type, input_tokens, output_tokens, req
        )

        if req.constraints.max_cost_per_call is not None:
            affordable = [c for c in scored if c.est_cost_usd <= req.constraints.max_cost_per_call]
            if affordable:
                scored = affordable
            else:
                warnings.append("no_model_within_cost_budget")

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

        if not recall.outcome_evidence:
            warnings.append("cold_start")
        if catalog.stale:
            warnings.append("prices_stale")

        self._propensity.record(lane, cluster, recommended.card.model_id)

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
                env_tags=list(req.task.tags),
                recommended_model_id=recommended.card.model_id,
                neighbors_by_model={
                    mid: [(ev.entry_id, ev.reference_id) for ev in agg.evidence]
                    for mid, agg in aggregates.items()
                },
            )
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
        )

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
        blend = self._settings.minima_reasoner_blend
        rankings = result.by_model()
        changed = False
        for c in scored:
            ranking = rankings.get(c.card.model_id)
            if ranking is None:
                continue
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
        return _optimize(scored, tau)

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
            predicted = score.with_exploration_bonus(
                predicted, confidence, settings.minima_exploration_bonus
            )
            use_cache = req.constraints.require_prompt_caching and card.supports_prompt_caching
            est_cost, breakdown = score.effective_cost(
                card, agg, input_tokens, output_tokens, use_cache, cost_basis, min_cost_n
            )
            cost_word = "obs" if ("observed_avg" in breakdown or "rescaled" in breakdown) else "est"

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
                    confidence=confidence,
                    est_cost_usd=est_cost,
                    est_cost_breakdown=breakdown,
                    decision_basis=basis,
                    evidence=evidence,
                    rationale=rationale,
                )
            )
        return scored


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
    scored: list[CandidateScore], tau: float
) -> tuple[CandidateScore, CandidateScore | None, list[CandidateScore], list[str]]:
    warnings: list[str] = []
    ranked = sorted(scored, key=lambda c: c.score, reverse=True)
    eligible = [c for c in scored if c.predicted_success >= tau]

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
    )
