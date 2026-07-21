"""Mapping between Minima's internal outcome model and Mubit memory metadata.

All three intake paths (explicit feedback, auto-capture, offline seed) converge on
this one record shape, so the recommender is agnostic to where evidence came from.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field, replace
from typing import Any

SCHEMA_VERSION = 5  # v5: recall-track counters + bi-temporal invalidation; v1-v4 parse unchanged

# Cap on recall votes applied per feedback (bounds Mubit writes per request).
RECALL_VOTE_CAP = 8

# Ring caps for the per-(cluster, model) durable record's accumulators. Small on
# purpose: the rings feed robust medians/quantiles (a dozen samples is plenty) and
# the whole record rides inside Mubit entry metadata.
COST_SAMPLE_RING = 12
REC_ID_RING = 8

# Provenance of the quality signal. Only labeled evidence may enter the success
# aggregate, reinforcement, or calibration; "none" is cost/latency telemetry.
EVIDENCE_GATE = "gate"  # deterministic verification (red->green check) — the only vip origin
EVIDENCE_JUDGE = "judge"  # LLM judge score
EVIDENCE_HUMAN = "human"  # caller-asserted outcome (SDK feedback without a judge)
EVIDENCE_DATASET = "dataset"  # offline seed (source_dataset set); never on the wire
EVIDENCE_NONE = "none"  # unjudged / infra failure — telemetry only

TRUSTED_LABEL_SOURCES = (EVIDENCE_GATE, EVIDENCE_JUDGE, EVIDENCE_HUMAN)
_LABELED_SOURCES = frozenset((*TRUSTED_LABEL_SOURCES, EVIDENCE_DATASET))

# Read-time score for a labeled outcome without an explicit quality: the Bernoulli
# label the Beta posterior is estimating. Never persisted — quality in storage is
# strictly what a judge/gate/caller supplied (or absent).
_OUTCOME_LABEL_SCORE = {"success": 1.0, "partial": 0.5, "failure": 0.0}

# Caller-supplied quality scores that flatly contradict the outcome label are clamped
# (never rejected — nuanced feedback like "succeeded but mediocre" must survive).
_FAILURE_QUALITY_CAP = 0.6
_SUCCESS_QUALITY_FLOOR = 0.4


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def clamp01(x: float) -> float:
    return _clamp(x, 0.0, 1.0)


def is_labeled(evidence_source: str) -> bool:
    return evidence_source in _LABELED_SOURCES


def label_score(outcome: str, quality_score: float | None) -> float:
    """Supplied quality wins; else the outcome's Bernoulli label. Pure, read-time only."""
    if quality_score is not None:
        return clamp01(float(quality_score))
    return _OUTCOME_LABEL_SCORE.get(outcome, 0.5)


def reconcile_quality(outcome: str, quality: float) -> tuple[float, str | None]:
    """Log-and-clamp gate for outcome/quality contradictions.

    A "failure" reported with quality 0.95 (or a "success" with 0.05) would poison the
    weighted-success aggregate with a label/score pair that can't both be true. Clamp
    into the consistent band and surface a warning so the caller can fix their scorer.
    """
    if outcome == "failure" and quality > _FAILURE_QUALITY_CAP:
        return _FAILURE_QUALITY_CAP, "quality_outcome_mismatch"
    if outcome == "success" and quality < _SUCCESS_QUALITY_FLOOR:
        return _SUCCESS_QUALITY_FLOOR, "quality_outcome_mismatch"
    return quality, None


def signal_from_outcome(outcome: str, quality: float | None) -> float:
    """Map an outcome+quality to a reinforcement signal in [-1, 1]."""
    q = label_score(outcome, quality)
    if outcome == "success":
        return 1.0
    if outcome == "partial":
        return _clamp(2.0 * q - 1.0, -1.0, 1.0)
    return _clamp(q - 1.0, -1.0, 0.0)  # failure


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
    # Strictly what a judge/gate/caller supplied; None when unlabeled. Read-time scoring
    # goes through label_score() — a default is never persisted.
    quality_score: float | None = None
    outcome: str = "success"
    # Provenance of the quality signal (EVIDENCE_*). Aggregation skips "none" records.
    evidence_source: str = EVIDENCE_NONE
    # Reasoning-effort tier the model ran at (client-reported; latest outcome's value).
    effort: str | None = None
    recommendation_id: str | None = None
    verified_in_production: bool = False
    source_dataset: str | None = None
    # Agent loop turns to resolution (token-yield signal; a cheap model that takes many
    # turns to resolve can cost more than one frontier turn). Backward-compatible: None
    # on legacy records.
    iterations: int | None = None
    # Unix seconds when the outcome was observed. Powers evidence age decay; None on
    # legacy (schema v1) records, which fall back to the binary staleness penalty.
    recorded_at: float | None = None
    # --- v4 accumulating counters (the durable (cluster, model) record is an upsert,
    # so history must live IN the record: without these, organic evidence caps at n=1
    # and one failure erases every prior success). All maintained by merged_outcome().
    n_outcomes: int = 0  # labeled outcomes folded into this record (0 = legacy/fresh)
    success_mass: float = 0.0  # sum of label_score over those outcomes
    cost_samples: list[float] = field(default_factory=list)  # realized $/call ring
    output_token_samples: list[int] = field(default_factory=list)
    latency_samples: list[int] = field(default_factory=list)
    recent_rec_ids: list[str] = field(default_factory=list)  # duplicate-feedback guard
    # --- v5 recall-track (arXiv:2505.16067 — "future task evaluations serve as free
    # quality labels for stored memory"). Every TRUSTED-label feedback casts one vote on
    # each record that was recalled into that decision: recall_n counts the votes,
    # recall_success_mass sums the successful ones. Deliberately SEPARATE from
    # n_outcomes/success_mass — recall votes are credit-assignment heuristics about the
    # record's usefulness as evidence, never direct observations of the model.
    recall_n: int = 0
    recall_success_mass: float = 0.0
    # Bi-temporal tombstone (Zep pattern): a record whose recall track record collapses
    # is invalidated, never deleted — aggregation skips it, audits still read it.
    invalidated_at: float | None = None
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
        raw_quality = parsed.get("quality_score")
        quality = clamp01(_as_float(raw_quality)) if raw_quality is not None else None
        source = parsed.get("evidence_source")
        if not source:
            # Legacy (v1/v2) records carry no provenance. Seeds and gate-verified records
            # are trustworthy by construction; everything else may carry a fabricated
            # label-based quality (pre-v3 write path) and is demoted to telemetry.
            if parsed.get("source_dataset"):
                source = EVIDENCE_DATASET
            elif bool(parsed.get("verified_in_production", False)):
                source = EVIDENCE_GATE
            else:
                source = EVIDENCE_NONE
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
            quality_score=quality,
            outcome=str(parsed.get("outcome", "success")),
            evidence_source=str(source),
            effort=(str(parsed["effort"]) if parsed.get("effort") else None),
            recommendation_id=parsed.get("recommendation_id"),
            verified_in_production=bool(parsed.get("verified_in_production", False)),
            source_dataset=parsed.get("source_dataset"),
            recorded_at=(
                _as_float(parsed.get("recorded_at")) if parsed.get("recorded_at") else None
            ),
            iterations=(_as_int(parsed.get("iterations")) if parsed.get("iterations") else None),
            n_outcomes=_as_int(parsed.get("n_outcomes")),
            success_mass=_as_float(parsed.get("success_mass")),
            cost_samples=_as_float_list(parsed.get("cost_samples")),
            output_token_samples=_as_int_list(parsed.get("output_token_samples")),
            latency_samples=_as_int_list(parsed.get("latency_samples")),
            recent_rec_ids=[str(r) for r in parsed.get("recent_rec_ids") or [] if r],
            recall_n=_as_int(parsed.get("recall_n")),
            recall_success_mass=_as_float(parsed.get("recall_success_mass")),
            invalidated_at=(
                _as_float(parsed.get("invalidated_at"))
                if parsed.get("invalidated_at")
                else None
            ),
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
    # Whether this entry can be re-read exactly via Dereference (durable fast path).
    referenceable: bool = False
    entry_type: str = ""
    # Entry id of the record that superseded this one (bi-temporal supersession).
    # A superseded entry is stale by definition even if is_stale lagged behind.
    superseded_by: str | None = None


@dataclass(slots=True)
class RecallResult:
    evidence: list[RecalledEvidence]
    degraded: bool = False
    raw_confidence: float = 0.0
    timed_out: bool = False
    error: str | None = None
    # Mubit DriftMonitor signals riding the query response (non-destructive diagnostics;
    # zeroed/absent means "no signal raised"). drift/novelty scores are -1 when unknown.
    drift_repeated: bool = False
    drift_stagnant: bool = False
    drift_score: float = -1.0
    novelty_score: float = -1.0
    # Class-specific warning label for the recommend response (memory_unreachable,
    # memory_auth_failed, memory_rejected_payload, memory_server_error, memory_recall_bug).
    # Set only on the error path; the engine surfaces it instead of a generic label.
    warning: str | None = None

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


def merged_outcome(prev: OutcomeRecord | None, new: OutcomeRecord) -> OutcomeRecord:
    """Fold a fresh labeled outcome into the durable (cluster, model) record.

    The durable record is a last-write-wins upsert in Mubit, so accumulation must
    happen here, read-modify-write style: counters and sample rings carry the
    history; the point-in-time fields (quality/outcome/cost/...) describe the
    LATEST outcome. Returns ``prev`` unchanged when ``new`` is a replay (its
    recommendation_id is already in the ring) — callers should skip reinforcement.
    Fail-open: with no readable prior record, ``new`` starts a fresh history (n=1).
    """
    if (
        prev is not None
        and new.recommendation_id
        and new.recommendation_id in prev.recent_rec_ids
    ):
        return prev

    base_n = prev.n_outcomes if prev is not None else 0
    base_mass = prev.success_mass if prev is not None else 0.0
    if prev is not None and prev.n_outcomes == 0:
        # v1-v3 record: its single stored outcome is one unit of history (only if it
        # was labeled — telemetry-era records contribute nothing to the success mass).
        if is_labeled(prev.evidence_source):
            base_n = 1
            base_mass = label_score(prev.outcome, prev.quality_score)

    def _ring(old: list, add: object | None, cap: int) -> list:
        items = list(old)
        if add:
            items.append(add)
        return items[-cap:]

    new.n_outcomes = base_n + 1
    new.success_mass = base_mass + label_score(new.outcome, new.quality_score)
    prev_costs = prev.cost_samples if prev is not None else []
    prev_tokens = prev.output_token_samples if prev is not None else []
    prev_lat = prev.latency_samples if prev is not None else []
    prev_recs = prev.recent_rec_ids if prev is not None else []
    new.cost_samples = _ring(
        prev_costs, new.cost_usd if new.cost_usd > 0 else None, COST_SAMPLE_RING
    )
    new.output_token_samples = _ring(
        prev_tokens, new.output_tokens if new.output_tokens > 0 else None, COST_SAMPLE_RING
    )
    new.latency_samples = _ring(
        prev_lat, new.latency_ms if new.latency_ms else None, COST_SAMPLE_RING
    )
    new.recent_rec_ids = _ring(prev_recs, new.recommendation_id or None, REC_ID_RING)
    # v5 recall-track state rides the same upsert: a direct outcome write must carry the
    # record's accumulated recall votes (and any invalidation stamp) forward, or every
    # feedback would silently reset the track record this PR exists to build.
    if prev is not None:
        new.recall_n = prev.recall_n
        new.recall_success_mass = prev.recall_success_mass
        new.invalidated_at = prev.invalidated_at
    return new


def fold_recall_vote(prev: OutcomeRecord, success: bool) -> OutcomeRecord:
    """Fold one recall vote into a recalled record's track record. Pure — returns a copy.

    A vote says "this record was recalled into a decision whose trusted-label outcome
    was success/failure". It never touches n_outcomes/success_mass (those are direct
    observations of the model); it grades the record's usefulness as *evidence*.
    """
    return replace(
        prev,
        recall_n=prev.recall_n + 1,
        recall_success_mass=prev.recall_success_mass + (1.0 if success else 0.0),
    )


def should_invalidate(
    record: OutcomeRecord, *, min_n: int, max_rate: float
) -> bool:
    """True when the record's recall track record has collapsed below the floor.

    Only fires with enough votes (min_n) and while the record is still live — the
    caller stamps ``invalidated_at`` (bi-temporal: never delete).
    """
    if min_n <= 0 or record.invalidated_at is not None:
        return False
    if record.recall_n < min_n:
        return False
    return (record.recall_success_mass / record.recall_n) < max_rate


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float_list(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    out: list[float] = []
    for v in value:
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _as_int_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    out: list[int] = []
    for v in value:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
