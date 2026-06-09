"""Recommendation endpoints (per-call and per-workflow-step)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

from costit.api.auth import get_tenant
from costit.schemas.recommend import RecommendRequest, RecommendResponse
from costit.schemas.workflow import (
    StepRecommendation,
    WorkflowRequest,
    WorkflowResponse,
)
from costit.tenancy.context import TenantContext

router = APIRouter(prefix="/v1", tags=["recommend"])


@router.post("/recommend", response_model=RecommendResponse)
async def recommend(
    req: RecommendRequest, tenant: TenantContext = Depends(get_tenant)
) -> RecommendResponse:
    return await tenant.recommender.recommend(req)


@router.post("/recommend/workflow", response_model=WorkflowResponse)
async def recommend_workflow(
    req: WorkflowRequest, tenant: TenantContext = Depends(get_tenant)
) -> WorkflowResponse:
    rec = tenant.recommender
    steps: list[StepRecommendation] = []
    total = 0.0
    premium = 0.0
    confidences: list[float] = []

    for step in req.steps:
        constraints = (
            step.constraints.merged_over(req.constraints) if step.constraints else req.constraints
        )
        sub = RecommendRequest(
            task=step.task,
            cost_quality_tradeoff=req.cost_quality_tradeoff,
            constraints=constraints,
            user_id=req.user_id,
            namespace=req.namespace,
            allow_llm_escalation=req.allow_llm_escalation,
        )
        resp = await rec.recommend(sub)
        steps.append(StepRecommendation(step_id=step.step_id, recommendation=resp))
        total += resp.recommended_model.est_cost_usd
        premium += max(
            (m.est_cost_usd for m in resp.ranked),
            default=resp.recommended_model.est_cost_usd,
        )
        confidences.append(resp.confidence)

    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return WorkflowResponse(
        workflow_recommendation_id=uuid.uuid4().hex,
        steps=steps,
        total_est_cost_usd=round(total, 8),
        total_est_cost_if_all_premium=round(premium, 8),
        confidence=round(confidence, 4),
    )
