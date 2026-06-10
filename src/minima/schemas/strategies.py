"""Schemas for the surfaced-strategies endpoint.

``reflect()`` promotes accumulated outcomes/lessons into validated rules; Mubit's
``surface_strategies`` clusters those lessons into ``EmergentStrategy`` summaries.
This endpoint exposes them so callers can see *why* a namespace routes the way it does.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, Field


def _g(d: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    """First present key among snake_case/camelCase variants."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


class Strategy(BaseModel):
    strategy_id: str = ""
    description: str = ""
    supporting_lesson_count: int = 0
    avg_confidence: float = 0.0
    avg_reinforcement: float = 0.0
    dominant_lesson_type: str = ""
    dominant_scope: str = ""
    lesson_ids: list[str] = Field(default_factory=list)

    @classmethod
    def from_emergent(cls, d: Mapping[str, Any]) -> Strategy:
        """Parse a Mubit ``EmergentStrategy`` dict (snake_case or camelCase)."""
        return cls(
            strategy_id=str(_g(d, "strategy_id", "strategyId", default="")),
            description=str(_g(d, "description", default="")),
            supporting_lesson_count=int(
                _g(d, "supporting_lesson_count", "supportingLessonCount", default=0)
            ),
            avg_confidence=float(_g(d, "avg_confidence", "avgConfidence", default=0.0)),
            avg_reinforcement=float(_g(d, "avg_reinforcement", "avgReinforcement", default=0.0)),
            dominant_lesson_type=str(
                _g(d, "dominant_lesson_type", "dominantLessonType", default="")
            ),
            dominant_scope=str(_g(d, "dominant_scope", "dominantScope", default="")),
            lesson_ids=[str(x) for x in (_g(d, "lesson_ids", "lessonIds", default=[]) or [])],
        )


class StrategiesResponse(BaseModel):
    namespace: str | None = None
    lane: str
    strategies: list[Strategy] = Field(default_factory=list)
    count: int = 0
