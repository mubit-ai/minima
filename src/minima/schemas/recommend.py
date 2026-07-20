"""Schemas for the per-call recommendation endpoint."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from minima.schemas.common import Constraints, DecisionBasis, Difficulty, TaskInput, TaskType


class ClassificationRuleProfile(BaseModel):
    task_type: TaskType
    pattern: str
    matched: bool
    feature_boosts: dict[str, float] = Field(default_factory=dict)


class ClassificationProfile(BaseModel):
    task_type_source: str
    difficulty_source: str
    caller_task_type: TaskType | None = None
    caller_difficulty: Difficulty | None = None
    heuristic_task_type: TaskType
    heuristic_difficulty: Difficulty
    final_task_type: TaskType
    final_difficulty: Difficulty
    selected_rule: str | None = None
    rule_checks: list[ClassificationRuleProfile] = Field(default_factory=list)
    extracted_features: dict[str, float] = Field(default_factory=dict)
    uncertainty: float = Field(..., ge=0, le=1)
    confidence: float = Field(..., ge=0, le=1)
    easy_route: bool = False
    neighbor_support: float = Field(0.0, ge=0, le=1)
    neighbor_count: int = Field(0, ge=0)
    timings_ms: dict[str, float] = Field(default_factory=dict)


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
            "The tenant boundary is your Minima API key -> your Mubit instance, not this field."
        ),
    )
    incumbent_model_id: str | None = Field(
        None,
        description=(
            "the model currently holding this session's context/prompt cache. Its "
            "ESTIMATE-basis input cost is priced partly at the cache-read rate "
            "(switching models forfeits the cache), so stickiness emerges from honest "
            "cost accounting rather than a post-hoc override — logged propensities "
            "stay valid."
        ),
    )
    max_candidates: int = Field(8, ge=1, le=64)
    allow_llm_escalation: bool = True
    explain: bool = True
    baseline_model_id: str | None = Field(
        None,
        description=(
            "the model you would have used without Minima; powers the vs_declared_default "
            "savings baseline in GET /v1/savings"
        ),
    )


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
    est_latency_ms: float | None = Field(
        None, description="observed latency percentile from similar past outcomes (ms)"
    )
    latency_basis: str = Field("", description='e.g. "observed_p75"; empty without evidence')
    est_cost_low: float | None = Field(
        None, ge=0, description="low end of the data-grounded predictable cost band ($)"
    )
    est_cost_high: float | None = Field(
        None, ge=0, description="high end of the data-grounded predictable cost band ($)"
    )
    cost_band_basis: str = Field(
        "", description='e.g. "observed_p25_p75" | "rescaled_p25_p75"; empty without a band'
    )
    success_interval_width: float = Field(
        0.0, ge=0, le=1, description="95% credible-interval width of predicted_success"
    )


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
    classification_profile: ClassificationProfile | None = None
    warnings: list[str] = Field(default_factory=list)
    selection_policy: str = Field(
        "argmin",
        description=(
            '"thompson" (default posterior-sampling policy) | "argmin" '
            "(deterministic; per-org opt-out or single-candidate/capped decisions)"
        ),
    )
    recommended_actions: list[str] = Field(
        default_factory=list,
        description="near-free cost-saving actions to apply (e.g. enable_prompt_cache)",
    )
    stage_latency_ms: dict[str, float] = Field(
        default_factory=dict, description="per-stage latency breakdown in milliseconds"
    )
