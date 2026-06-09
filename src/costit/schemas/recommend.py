"""Schemas for the per-call recommendation endpoint."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from costit.schemas.common import Constraints, DecisionBasis, Difficulty, TaskInput, TaskType


class RecommendRequest(BaseModel):
    task: TaskInput
    cost_quality_tradeoff: float = Field(
        5.0, ge=0, le=10, description="0 = cheapest acceptable, 10 = highest quality"
    )
    constraints: Constraints = Field(default_factory=Constraints)
    user_id: str | None = Field(
        None, description="optional within-org actor label (NOT a tenant/auth boundary)"
    )
    namespace: str | None = Field(
        None,
        description=(
            "optional within-org sub-scope (team/project/env), namespaced under your org. "
            "The tenant boundary is your Costit API key -> your Mubit instance, not this field."
        ),
    )
    max_candidates: int = Field(8, ge=1, le=64)
    allow_llm_escalation: bool = True
    explain: bool = True


class EvidenceRef(BaseModel):
    """A recalled past outcome that informed a candidate's score."""

    model_config = ConfigDict(protected_namespaces=())

    entry_id: str = Field(..., description="QueryEvidence.id (used for outcome attribution)")
    reference_id: str | None = None
    model_id: str
    score: float = Field(..., description="retrieval similarity")
    knowledge_confidence: float = Field(..., ge=0, le=1)
    observed_success: float = Field(..., ge=0, le=1)
    is_stale: bool = False


class RankedModel(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    provider: str
    predicted_success: float = Field(..., ge=0, le=1)
    est_cost_usd: float = Field(..., ge=0)
    est_cost_breakdown: dict[str, float] = Field(default_factory=dict)
    score: float = Field(..., description="final objective score; sorting key")
    rationale: str = ""
    decision_basis: DecisionBasis = DecisionBasis.prior
    evidence: list[EvidenceRef] = Field(default_factory=list)
    supports_prompt_caching: bool = False
    context_window: int = 0


class RecommendResponse(BaseModel):
    recommendation_id: str
    recommended_model: RankedModel
    ranked: list[RankedModel] = Field(default_factory=list)
    fallback_model: RankedModel | None = None
    confidence: float = Field(..., ge=0, le=1)
    decision_basis: DecisionBasis
    threshold_used: float
    classified_task_type: TaskType
    classified_difficulty: Difficulty
    catalog_version: str
    catalog_stale: bool = False
    latency_ms: int = 0
    warnings: list[str] = Field(default_factory=list)
