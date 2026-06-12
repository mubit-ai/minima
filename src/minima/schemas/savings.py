"""Schemas for the savings and calibration reporting endpoints.

The payload bodies reuse the metrics dataclasses directly (pydantic v2 validates and
serializes stdlib dataclasses), so the report shape has exactly one definition.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from minima.metrics.calibration import CalibrationReport, CusumFlag
from minima.metrics.savings import SavingsSummary


class SavingsGroup(BaseModel):
    key: str
    summary: SavingsSummary
    health: dict[str, float | int] = Field(default_factory=dict)


class SavingsResponse(BaseModel):
    org_id: str
    since: float
    days: float
    namespace: str | None = None
    summary: SavingsSummary
    health: dict[str, float | int] = Field(default_factory=dict)
    group_by: str | None = None
    groups: list[SavingsGroup] = Field(default_factory=list)


class CalibrationResponse(BaseModel):
    org_id: str
    since: float
    days: float
    namespace: str | None = None
    health: dict[str, float | int] = Field(default_factory=dict)
    reports: list[CalibrationReport] = Field(default_factory=list)
    drift_flags: list[CusumFlag] = Field(default_factory=list)
