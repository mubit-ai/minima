"""Schema for the /v1/capabilities response."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CapabilitiesResponse(BaseModel):
    plan: bool = Field(description="POST /v1/plan (goal → Delegation DAG) is available")
    workflow: bool = Field(description="POST /v1/recommend/workflow is available")
    api_version: str = Field(description="Running server version")
    honored_constraints: list[str] = Field(
        default_factory=list,
        description="Constraint fields the engine actively filters on",
    )
