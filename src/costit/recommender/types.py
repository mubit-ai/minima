"""Internal dataclasses shared across the recommender stages."""

from __future__ import annotations

from dataclasses import dataclass, field

from costit.memory.records import RecalledEvidence
from costit.schemas.common import DecisionBasis
from costit.schemas.models_catalog import ModelCard


@dataclass(slots=True)
class ModelAggregate:
    """Weighted summary of recalled outcomes for one candidate model."""

    model_id: str
    weight_sum: float = 0.0
    weighted_success: float = 0.0
    n: int = 0
    avg_knowledge_confidence: float = 0.0
    evidence: list[RecalledEvidence] = field(default_factory=list)

    @property
    def weighted_success_rate(self) -> float:
        if self.weight_sum <= 0:
            return 0.0
        return self.weighted_success / self.weight_sum


@dataclass(slots=True)
class CandidateScore:
    card: ModelCard
    predicted_success: float
    confidence: float
    est_cost_usd: float
    est_cost_breakdown: dict[str, float]
    decision_basis: DecisionBasis
    evidence: list[RecalledEvidence] = field(default_factory=list)
    score: float = 0.0
    rationale: str = ""
