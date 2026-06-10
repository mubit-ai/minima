"""Schemas for the multi-step workflow recommendation endpoint."""

from __future__ import annotations

from pydantic import BaseModel, Field

from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendResponse


class WorkflowStep(BaseModel):
    step_id: str = Field(..., min_length=1)
    task: TaskInput
    constraints: Constraints | None = Field(
        None, description="per-step override; merged over global"
    )
    depends_on: list[str] = Field(default_factory=list)


class WorkflowRequest(BaseModel):
    steps: list[WorkflowStep] = Field(..., min_length=1)
    cost_quality_tradeoff: float = Field(5.0, ge=0, le=10)
    constraints: Constraints = Field(default_factory=Constraints)
    user_id: str | None = Field(
        None, description="optional within-org actor label (NOT a tenant/auth boundary)"
    )
    namespace: str | None = Field(
        None, description="optional within-org sub-scope; tenant boundary is the Minima key"
    )
    allow_llm_escalation: bool = True


class StepRecommendation(BaseModel):
    step_id: str
    recommendation: RecommendResponse


class WorkflowResponse(BaseModel):
    workflow_recommendation_id: str
    steps: list[StepRecommendation]
    total_est_cost_usd: float = Field(..., ge=0)
    total_est_cost_if_all_premium: float = Field(..., ge=0)
    confidence: float = Field(..., ge=0, le=1)
