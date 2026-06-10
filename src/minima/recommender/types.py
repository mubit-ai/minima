"""Internal dataclasses shared across the recommender stages."""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.memory.records import RecalledEvidence
from minima.schemas.common import DecisionBasis
from minima.schemas.models_catalog import ModelCard


def _weighted_median(pairs: list[tuple[float, float]]) -> float:
    """Lower weighted median of (value, weight) pairs (robust to outliers)."""
    items = sorted(pairs, key=lambda vw: vw[0])
    total = sum(w for _, w in items)
    if total <= 0.0:  # all-zero weights -> plain median
        vals = [v for v, _ in items]
        return vals[len(vals) // 2]
    half, acc = total / 2.0, 0.0
    for value, weight in items:
        acc += weight
        if acc >= half:
            return value
    return items[-1][0]


@dataclass(slots=True)
class ModelAggregate:
    """Weighted summary of recalled outcomes for one candidate model."""

    model_id: str
    weight_sum: float = 0.0
    weighted_success: float = 0.0
    n: int = 0
    avg_knowledge_confidence: float = 0.0
    evidence: list[RecalledEvidence] = field(default_factory=list)

    @property
    def weighted_success_rate(self) -> float:
        if self.weight_sum <= 0:
            return 0.0
        return self.weighted_success / self.weight_sum

    def observed_cost(self, min_n: int) -> float | None:
        """Robust realized $/call over cost-bearing neighbors: a similarity-weighted MEDIAN.

        A realized cost is an objective measurement, so it is weighted by topical similarity
        only — NOT by the staleness/knowledge-confidence factors that legitimately discount the
        *success* signal (a past call's dollar amount doesn't get cheaper because the record is
        old). The median keeps a single mis-recorded or pathological cost_usd (wrong units, a
        cumulative total, a timed-out retry) from dominating. Returns None when fewer than
        ``min_n`` recalled neighbors carry a positive cost.
        """
        pairs = [
            (ev.record.cost_usd, max(0.0, ev.score))
            for ev in self.evidence
            if ev.record is not None and ev.record.cost_usd and ev.record.cost_usd > 0.0
        ]
        if len(pairs) < min_n:
            return None
        return _weighted_median(pairs)

    def observed_output_tokens(self, min_n: int) -> float | None:
        """Robust median realized OUTPUT tokens/call (incl. reasoning/thinking) over neighbors.

        Captures the model's true output behavior on similar tasks — the part a flat token
        estimate misses — so cost can be re-scaled to the current request's input size while
        keeping the realized output (thinking) volume. Similarity-weighted median; None when
        fewer than ``min_n`` recalled neighbors carry an output-token count.
        """
        pairs = [
            (float(ev.record.output_tokens), max(0.0, ev.score))
            for ev in self.evidence
            if ev.record is not None and ev.record.output_tokens and ev.record.output_tokens > 0
        ]
        if len(pairs) < min_n:
            return None
        return _weighted_median(pairs)


@dataclass(slots=True)
class CandidateScore:
    card: ModelCard
    predicted_success: float
    confidence: float
    est_cost_usd: float
    est_cost_breakdown: dict[str, float]
    decision_basis: DecisionBasis
    evidence: list[RecalledEvidence] = field(default_factory=list)
    score: float = 0.0
    rationale: str = ""
