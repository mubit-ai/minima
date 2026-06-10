"""Turn recalled outcomes into a weighted per-model summary."""

from __future__ import annotations

from collections.abc import Iterable

from costit.memory.records import RecalledEvidence, clamp01
from costit.recommender.types import ModelAggregate

# Floor on the confidence multiplier so freshly-seeded (un-reinforced) but
# topically-relevant evidence still counts — just less than reinforced evidence.
KC_FLOOR = 0.3
STALE_DECAY = 0.5


def neighbor_weight(ev: RecalledEvidence) -> float:
    similarity = max(0.0, ev.score)
    confidence_mult = KC_FLOOR + (1.0 - KC_FLOOR) * clamp01(ev.knowledge_confidence)
    decay = STALE_DECAY if ev.is_stale else 1.0
    return similarity * confidence_mult * decay


def aggregate_by_model(
    evidence: Iterable[RecalledEvidence],
    candidate_ids: set[str] | None = None,
) -> dict[str, ModelAggregate]:
    """Group neighbors by model and accumulate weighted success statistics."""
    aggs: dict[str, ModelAggregate] = {}
    kc_totals: dict[str, float] = {}

    for ev in evidence:
        rec = ev.record
        if rec is None:
            continue
        model_id = rec.model_id
        if candidate_ids is not None and model_id not in candidate_ids:
            continue

        weight = neighbor_weight(ev)
        agg = aggs.get(model_id)
        if agg is None:
            agg = ModelAggregate(model_id=model_id)
            aggs[model_id] = agg
            kc_totals[model_id] = 0.0

        y = clamp01(rec.quality_score)
        agg.weight_sum += weight
        agg.weighted_success += weight * y
        agg.n += 1
        agg.evidence.append(ev)
        kc_totals[model_id] += clamp01(ev.knowledge_confidence)
        # Observed cost is derived on demand from agg.evidence (robust median, similarity
        # weighted) — see ModelAggregate.observed_cost — not accumulated here.

    for model_id, agg in aggs.items():
        agg.avg_knowledge_confidence = kc_totals[model_id] / agg.n if agg.n else 0.0

    return aggs


def is_conflicted(agg: ModelAggregate, min_n: int = 4, lo: float = 0.4, hi: float = 0.6) -> bool:
    """A model whose neighbors split between success and failure."""
    return agg.n >= min_n and lo <= agg.weighted_success_rate <= hi


def apply_ipw(
    aggs: dict[str, ModelAggregate],
    propensities: dict[str, float],
    clip_low: float,
    clip_high: float,
) -> None:
    """Re-weight each model's evidence mass by clipped inverse propensity, in place.

    Scaling weight_sum and weighted_success by the same factor preserves the
    empirical success rate while up-weighting evidence from rarely-recommended
    models (low propensity) so it isn't drowned out by selection bias.
    """
    for model_id, agg in aggs.items():
        pi = propensities.get(model_id)
        if not pi or pi <= 0:
            continue
        factor = min(clip_high, max(clip_low, 1.0 / pi))
        agg.weight_sum *= factor
        agg.weighted_success *= factor
