"""MinimaRouter — the thin seam between the harness and a running Minima service.

Owns the two halves of the Minima loop on the harness side: ``recommend`` (ask Minima
which model, map it to a callable harness model) and ``feedback`` (report the realized
tokens / cost / latency / quality so Minima's memory sharpens). Realized cost comes from
the provider's actual usage (``usage.cost.total``), NOT Minima's prior estimate — that is
what lets the cost basis climb estimate -> observed -> rescaled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from minima_client import AsyncMinimaClient

from minima.schemas.common import Constraints
from minima_harness.ai.types import Model, Usage
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.mapping import ModelMapping

_log = logging.getLogger("minima_harness.router")


@dataclass(slots=True)
class Ranking:
    """A harness-native view of one ranked candidate (no minima schema leak)."""

    model_id: str
    provider: str
    predicted_success: float
    est_cost_usd: float
    rationale: str = ""
    decision_basis: str = ""
    # Speed + predictability axes (server provides these; the harness now surfaces them).
    est_latency_ms: float | None = None
    latency_basis: str = ""
    est_cost_low: float | None = None
    est_cost_high: float | None = None
    cost_band_basis: str = ""
    success_interval_width: float = 0.0
    evidence_count: int = 0


@dataclass(slots=True)
class RoutingResult:
    """The outcome of a routing decision for one prompt.

    Carries Minima's full explainability payload (ranked list, rationale, warnings,
    threshold, confidence, fallback) plus ``baseline_cost_usd`` — the estimated cost of
    ``config.baseline_model_id`` within the ranked set, which powers the cost meter's
    "savings vs your default" number.
    """

    recommendation_id: str | None
    chosen_model_id: str | None
    model: Model
    est_cost_usd: float
    decision_basis: str
    ranked: list[Ranking] = field(default_factory=list)
    rationale: str = ""
    warnings: list[str] = field(default_factory=list)
    threshold_used: float = 0.0
    confidence: float = 0.0
    fallback_model_id: str | None = None
    baseline_cost_usd: float | None = None
    # Predictable cost band for the chosen model (None when evidence is thin).
    est_cost_low: float | None = None
    est_cost_high: float | None = None
    cost_band_basis: str = ""


def _baseline_cost(ranked: list[Ranking], baseline_id: str | None) -> float | None:
    if not baseline_id:
        return None
    for r in ranked:
        if r.model_id == baseline_id:
            return r.est_cost_usd
    return None


class MinimaRouter:
    def __init__(
        self,
        client: AsyncMinimaClient,
        config: HarnessConfig,
        mapping: ModelMapping | None = None,
    ) -> None:
        self._client = client
        self.config = config
        self.mapping = mapping or ModelMapping()

    @classmethod
    def for_config(cls, config: HarnessConfig, mapping: ModelMapping | None = None) -> MinimaRouter:
        client = AsyncMinimaClient(config.minima_url, config.minima_api_key, config.timeout)
        return cls(client, config, mapping)

    async def recommend(
        self,
        task: str,
        *,
        task_type: str | None = None,
        slider: float | None = None,
        tags: list[str] | None = None,
        difficulty: str | None = None,
        expected_input_tokens: int | None = None,
    ) -> RoutingResult:
        constraints = (
            Constraints(candidate_models=list(self.config.candidates))
            if self.config.candidates
            else None
        )
        # Build a TaskInput only when code-quality signals (or a task_type) enrich it;
        # otherwise pass the bare prompt string (the cheaper wire shape).
        task_input: dict | str = task
        if task_type or tags or difficulty or expected_input_tokens is not None:
            task_input = {"task": task}
            if task_type:
                task_input["task_type"] = task_type
            if tags:
                task_input["tags"] = tags
            if difficulty:
                task_input["difficulty"] = difficulty
            if expected_input_tokens is not None:
                task_input["expected_input_tokens"] = expected_input_tokens
        rec = await self._client.recommend(
            task_input,
            cost_quality_tradeoff=slider
            if slider is not None
            else self.config.cost_quality_tradeoff,
            constraints=constraints,
            namespace=self.config.namespace,
            baseline_model_id=self.config.baseline_model_id,
        )
        ranked = rec.recommended_model
        model = self.mapping.to_model(ranked, offline_default=self.mapping.default_model())
        ranking_list = [
            Ranking(
                model_id=r.model_id,
                provider=r.provider,
                predicted_success=r.predicted_success,
                est_cost_usd=r.est_cost_usd,
                rationale=r.rationale,
                decision_basis=str(r.decision_basis),
                est_latency_ms=r.est_latency_ms,
                latency_basis=r.latency_basis,
                est_cost_low=r.est_cost_low,
                est_cost_high=r.est_cost_high,
                cost_band_basis=r.cost_band_basis,
                success_interval_width=r.success_interval_width,
                evidence_count=len(r.evidence),
            )
            for r in rec.ranked
        ]
        return RoutingResult(
            recommendation_id=rec.recommendation_id,
            chosen_model_id=ranked.model_id,
            model=model,
            est_cost_usd=ranked.est_cost_usd,
            decision_basis=str(rec.decision_basis),
            ranked=ranking_list,
            rationale=ranked.rationale,
            warnings=list(rec.warnings),
            threshold_used=rec.threshold_used,
            confidence=rec.confidence,
            fallback_model_id=rec.fallback_model.model_id if rec.fallback_model else None,
            baseline_cost_usd=_baseline_cost(ranking_list, self.config.baseline_model_id),
            est_cost_low=ranked.est_cost_low,
            est_cost_high=ranked.est_cost_high,
            cost_band_basis=ranked.cost_band_basis,
        )

    async def feedback(
        self,
        recommendation_id: str,
        chosen_model_id: str,
        outcome: str,
        *,
        quality: float | None,
        usage: Usage,
        latency_ms: int,
        iterations: int | None = None,
    ) -> None:
        await self._client.feedback(
            recommendation_id,
            chosen_model_id,
            outcome,
            quality_score=quality,
            input_tokens=usage.input or None,
            output_tokens=usage.output or None,
            actual_cost_usd=round(usage.cost.total, 8),
            latency_ms=latency_ms,
            iterations=iterations,
            verified_in_production=True,
        )
