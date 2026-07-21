"""Schemas for the memory-insight endpoints (diagnose + memory health).

Both relay Mubit introspection to the caller: ``diagnose`` surfaces failure
lessons matching an error at recovery time; ``memory_health`` reports the
namespace's memory hygiene (staleness, contradictions, promotion candidates).
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


class DiagnoseRequest(BaseModel):
    error_text: str = Field(..., min_length=1, description="the error/failure output to match")
    error_type: str | None = None
    limit: int = Field(5, ge=1, le=25)
    namespace: str | None = None
    user_id: str | None = None


class FailureLesson(BaseModel):
    lesson_id: str = ""
    content: str = ""
    lesson_type: str = ""
    importance: str = ""
    confidence: float = 0.0

    @classmethod
    def from_raw(cls, d: Mapping[str, Any]) -> FailureLesson:
        return cls(
            lesson_id=str(_g(d, "lesson_id", "lessonId", "id", default="")),
            content=str(_g(d, "content", "lesson", default="")),
            lesson_type=str(_g(d, "lesson_type", "lessonType", default="")),
            importance=str(_g(d, "importance", default="")),
            confidence=float(_g(d, "confidence", default=0.0) or 0.0),
        )


class DiagnoseResponse(BaseModel):
    namespace: str | None = None
    lane: str = ""
    failure_lessons: list[FailureLesson] = Field(default_factory=list)
    summary: str = ""
    total_failure_lessons: int = 0
    warnings: list[str] = Field(default_factory=list)


class MemoryHealthResponse(BaseModel):
    namespace: str | None = None
    lane: str = ""
    entry_counts: dict[str, int] = Field(default_factory=dict)
    stale_entries: int = 0
    contradictions: int = 0
    low_confidence_count: int = 0
    promotion_candidates: int = 0
    section_health: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
