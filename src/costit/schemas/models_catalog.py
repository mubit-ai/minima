"""Schemas for the model catalog endpoint."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from costit.schemas.common import TaskType


class ModelCard(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    provider: str
    display_name: str = ""
    input_cost_per_mtok: float = Field(..., ge=0)
    output_cost_per_mtok: float = Field(..., ge=0)
    cache_read_cost_per_mtok: float | None = None
    supports_prompt_caching: bool = False
    context_window: int = 0
    max_output_tokens: int | None = None
    capability_priors: dict[str, float] = Field(default_factory=dict)
    capability_by_task_type: dict[TaskType, float] = Field(default_factory=dict)
    cost_source: str = ""
    cost_fetched_at: datetime | None = None
    cost_stale: bool = False
    capability_source: str = ""


class ModelsResponse(BaseModel):
    models: list[ModelCard]
    catalog_version: str
    refreshed_at: datetime | None = None
    stale: bool = False
