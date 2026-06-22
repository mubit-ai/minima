"""Schemas for the feedback / learning-loop endpoint."""

from __future__ import annotations

from pydantic import BaseModel, Field

from minima.schemas.common import OutcomeLabel


class FeedbackRequest(BaseModel):
    recommendation_id: str = Field(..., min_length=1)
    chosen_model_id: str = Field(..., min_length=1, description="model actually run (may differ)")
    outcome: OutcomeLabel
    quality_score: float | None = Field(None, ge=0, le=1, description="caller-supplied; no judge")
    input_tokens: int | None = Field(None, ge=0)
    output_tokens: int | None = Field(None, ge=0)
    actual_cost_usd: float | None = Field(None, ge=0)
    latency_ms: int | None = Field(None, ge=0)
    iterations: int | None = Field(
        None, ge=0, description="agent loop turns to resolution (token-yield signal)"
    )
    verified_in_production: bool = False
    notes: str | None = None
    idempotency_key: str | None = None


class FeedbackResponse(BaseModel):
    accepted: bool
    record_id: str | None = None
    reinforced_entry_ids: list[str] = Field(default_factory=list)
    updated_confidence: float | None = None
    reflection_triggered: bool = False
    lesson_promoted: bool = False
    warnings: list[str] = Field(default_factory=list)
