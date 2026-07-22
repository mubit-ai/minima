"""Shared enums and request building blocks."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class TaskType(StrEnum):
    code = "code"
    summarization = "summarization"
    extraction = "extraction"
    qa = "qa"
    reasoning = "reasoning"
    classification = "classification"
    translation = "translation"
    creative = "creative"
    rag = "rag"
    tool_use = "tool_use"
    other = "other"


class Difficulty(StrEnum):
    trivial = "trivial"
    easy = "easy"
    medium = "medium"
    hard = "hard"
    expert = "expert"


class OutcomeLabel(StrEnum):
    success = "success"
    partial = "partial"
    failure = "failure"


class DecisionBasis(StrEnum):
    """Which path produced a recommendation."""

    memory = "memory"  # driven by empirical recalled outcomes
    prior = "prior"  # driven by capability priors (thin/no memory)
    llm = "llm"  # cheap-LLM reasoner was consulted


class Constraints(BaseModel):
    """Optional hard limits a caller can place on the candidate set."""

    allowed_providers: list[str] | None = None
    candidate_models: list[str] | None = None
    excluded_models: list[str] | None = None
    max_cost_per_call: float | None = Field(None, ge=0, description="USD; hard filter")
    min_quality: float | None = Field(None, ge=0, le=1, description="predicted_success floor")
    require_prompt_caching: bool = False
    max_latency_ms: int | None = Field(None, gt=0)
    require_context_window: int | None = Field(None, gt=0)

    def merged_over(self, base: Constraints) -> Constraints:
        """Return self with any unset field inherited from ``base``."""
        data = base.model_dump()
        for key, value in self.model_dump().items():
            if value is not None and value is not False:
                data[key] = value
        return Constraints(**data)


class TaskInput(BaseModel):
    task: str = Field(..., min_length=1, description="Raw task/prompt text; embedded by Mubit")
    task_type: TaskType | None = None
    difficulty: Difficulty | None = None
    task_type_confidence: float | None = Field(
        None,
        ge=0,
        le=1,
        description=(
            "caller's classifier confidence in its task_type/difficulty override; "
            "diagnostic only — the override wins regardless"
        ),
    )
    expected_input_tokens: int | None = Field(None, ge=0)
    expected_output_tokens: int | None = Field(None, ge=0)
    tags: list[str] = Field(default_factory=list, description="-> Mubit env_tags")
