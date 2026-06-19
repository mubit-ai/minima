"""MinimaRouter — the thin seam between the harness and a running Minima service.

Owns the two halves of the Minima loop on the harness side: ``recommend`` (ask Minima
which model, map it to a callable harness model) and ``feedback`` (report the realized
tokens / cost / latency / quality so Minima's memory sharpens). Realized cost comes from
the provider's actual usage (``usage.cost.total``), NOT Minima's prior estimate — that is
what lets the cost basis climb estimate -> observed -> rescaled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from minima_client import AsyncMinimaClient

from minima.schemas.common import Constraints
from minima_harness.ai.types import Model, Usage
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.mapping import ModelMapping

_log = logging.getLogger("minima_harness.router")


@dataclass(slots=True)
class RoutingResult:
    """The outcome of a routing decision for one prompt."""

    recommendation_id: str | None
    chosen_model_id: str | None
    model: Model
    est_cost_usd: float
    decision_basis: str


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
    ) -> RoutingResult:
        constraints = (
            Constraints(candidate_models=list(self.config.candidates))
            if self.config.candidates
            else None
        )
        rec = await self._client.recommend(
            {"task": task, "task_type": task_type} if task_type else task,
            cost_quality_tradeoff=slider
            if slider is not None
            else self.config.cost_quality_tradeoff,
            constraints=constraints,
            namespace=self.config.namespace,
            baseline_model_id=self.config.baseline_model_id,
        )
        ranked = rec.recommended_model
        model = self.mapping.to_model(ranked, offline_default=self.mapping.default_model())
        return RoutingResult(
            recommendation_id=rec.recommendation_id,
            chosen_model_id=ranked.model_id,
            model=model,
            est_cost_usd=ranked.est_cost_usd,
            decision_basis=str(rec.decision_basis),
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
            verified_in_production=True,
        )
