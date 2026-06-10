"""Mapping between Minima's internal outcome model and Mubit memory metadata.

All three intake paths (explicit feedback, auto-capture, offline seed) converge on
this one record shape, so the recommender is agnostic to where evidence came from.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from typing import Any

SCHEMA_VERSION = 1

_OUTCOME_DEFAULT_QUALITY = {"success": 0.9, "partial": 0.5, "failure": 0.1}


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def clamp01(x: float) -> float:
    return _clamp(x, 0.0, 1.0)


def quality_from_outcome(outcome: str, quality_score: float | None) -> float:
    """Caller-supplied quality wins; else a label-based default."""
    if quality_score is not None:
        return clamp01(float(quality_score))
    return _OUTCOME_DEFAULT_QUALITY.get(outcome, 0.5)


def signal_from_outcome(outcome: str, quality: float) -> float:
    """Map an outcome+quality to a reinforcement signal in [-1, 1]."""
    if outcome == "success":
        return 1.0
    if outcome == "partial":
        return _clamp(2.0 * quality - 1.0, -1.0, 1.0)
    return _clamp(quality - 1.0, -1.0, 0.0)  # failure


@dataclass(slots=True)
class OutcomeRecord:
    """A single (task, model, outcome) observation."""

    model_id: str
    provider: str = ""
    task_type: str = "other"
    difficulty: str = "medium"
    task_fingerprint: str = ""
    task_cluster: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int | None = None
    quality_score: float = 0.0
    outcome: str = "success"
    recommendation_id: str | None = None
    verified_in_production: bool = False
    source_dataset: str | None = None
    kind: str = "outcome"
    schema_version: int = SCHEMA_VERSION
    extra: dict = field(default_factory=dict)

    def to_metadata(self) -> dict:
        data = asdict(self)
        extra = data.pop("extra", {}) or {}
        return {**extra, **{k: v for k, v in data.items() if v is not None}}

    @classmethod
    def from_metadata(cls, meta: Mapping | str | None) -> OutcomeRecord | None:
        """Parse a Mubit ``metadata_json`` (string or dict) into an OutcomeRecord.

        Returns ``None`` when the entry is not a Minima outcome record.
        """
        parsed = _coerce_mapping(meta)
        if not parsed:
            return None
        if parsed.get("kind") != "outcome":
            return None
        model_id = parsed.get("model_id")
        if not model_id:
            return None
        return cls(
            model_id=str(model_id),
            provider=str(parsed.get("provider", "")),
            task_type=str(parsed.get("task_type", "other")),
            difficulty=str(parsed.get("difficulty", "medium")),
            task_fingerprint=str(parsed.get("task_fingerprint", "")),
            task_cluster=str(parsed.get("task_cluster", "")),
            input_tokens=_as_int(parsed.get("input_tokens")),
            output_tokens=_as_int(parsed.get("output_tokens")),
            cost_usd=_as_float(parsed.get("cost_usd")),
            latency_ms=_as_int(parsed.get("latency_ms")) if parsed.get("latency_ms") else None,
            quality_score=clamp01(_as_float(parsed.get("quality_score"))),
            outcome=str(parsed.get("outcome", "success")),
            recommendation_id=parsed.get("recommendation_id"),
            verified_in_production=bool(parsed.get("verified_in_production", False)),
            source_dataset=parsed.get("source_dataset"),
        )


@dataclass(slots=True)
class RecalledEvidence:
    """One recalled Mubit entry, with its parsed outcome record (if any)."""

    entry_id: str
    reference_id: str | None
    score: float
    knowledge_confidence: float
    is_stale: bool
    content: str
    record: OutcomeRecord | None


@dataclass(slots=True)
class RecallResult:
    evidence: list[RecalledEvidence]
    degraded: bool = False
    raw_confidence: float = 0.0
    timed_out: bool = False
    error: str | None = None

    @property
    def outcome_evidence(self) -> list[RecalledEvidence]:
        return [e for e in self.evidence if e.record is not None]


def _coerce_mapping(meta: Mapping | str | None) -> dict | None:
    if meta is None:
        return None
    if isinstance(meta, str):
        if not meta.strip():
            return None
        try:
            loaded = json.loads(meta)
        except (json.JSONDecodeError, ValueError):
            return None
        return loaded if isinstance(loaded, dict) else None
    if isinstance(meta, Mapping):
        return dict(meta)
    return None


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
