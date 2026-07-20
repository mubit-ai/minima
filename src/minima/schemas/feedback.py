"""Schemas for the feedback / learning-loop endpoint."""

from __future__ import annotations

from typing import Literal

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
    evidence_source: Literal["gate", "judge", "human", "none"] | None = Field(
        None,
        description=(
            "Provenance of the quality signal. gate = deterministic verification "
            "(red->green check; the only origin that may claim verified-in-production); "
            "judge = LLM judge; human = caller-asserted; none = unjudged — the outcome "
            "enters cost/latency telemetry only, never the success aggregate, "
            "reinforcement, or calibration. When omitted, derived from the legacy "
            "judged/verified_in_production flags."
        ),
    )
    error_cause: Literal["infra", "quality"] | None = Field(
        None,
        description=(
            "For outcome=failure: infra = provider/tooling fault (429/5xx/timeout) — "
            "telemetry only, never recorded as a model-quality signal; quality = the "
            "model genuinely produced a bad result."
        ),
    )
    verified_in_production: bool = Field(
        False, description="DEPRECATED: send evidence_source='gate' instead."
    )
    judged: bool | None = Field(
        None,
        description=(
            "DEPRECATED: send evidence_source instead. True maps to 'judge', "
            "False to 'none'; omitted (old SDK clients) maps to 'human' "
            "(caller-asserted outcome)."
        ),
    )
    chosen_effort: str | None = Field(
        None,
        description=(
            "reasoning-effort tier the model ran at (e.g. low/medium/high). Recorded "
            "on the outcome record and decision log so (model x effort) arms can be "
            "learned; not yet a routing dimension."
        ),
    )
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
