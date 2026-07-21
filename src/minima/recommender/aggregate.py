"""Turn recalled outcomes into a weighted per-model summary."""

from __future__ import annotations

import time
from collections.abc import Iterable

from minima.memory.records import (
    EVIDENCE_HUMAN,
    OutcomeRecord,
    RecalledEvidence,
    clamp01,
    is_labeled,
    label_score,
)
from minima.recommender.types import ModelAggregate

# Floor on the confidence multiplier so freshly-seeded (un-reinforced) but
# topically-relevant evidence still counts — just less than reinforced evidence.
KC_FLOOR = 0.3
STALE_DECAY = 0.5

# Cap on how much evidence mass a single durable record's accumulated history may
# contribute. Bounds one (cluster, model) record's dominance and keeps the age decay
# (which applies to the record as a whole) meaningful for long histories.
COUNTER_N_CAP = 50

# Floor on the recall-track down-weight: a record whose recalls keep preceding failures
# is discounted toward (but never to) zero — evidence gets cheaper, not censored; hard
# removal is the invalidation stamp's job, applied at write time with its own threshold.
RECALL_WEIGHT_FLOOR = 0.25

_SECONDS_PER_DAY = 86_400.0


def age_decay(
    recorded_at: float | None,
    *,
    half_life_days: float,
    floor: float,
    now: float | None = None,
) -> float | None:
    """Exponential observation-age decay: halves every half-life, floored.

    None when the record has no timestamp (legacy schema v1) — caller falls back to
    the binary staleness penalty. Future-dated timestamps clamp to no decay.
    """
    if recorded_at is None or recorded_at <= 0.0 or half_life_days <= 0.0:
        return None
    ref_now = now if now is not None else time.time()
    age_days = max(0.0, ref_now - recorded_at) / _SECONDS_PER_DAY
    return max(floor, 0.5 ** (age_days / half_life_days))


def neighbor_weight(
    ev: RecalledEvidence,
    *,
    half_life_days: float = 0.0,
    decay_floor: float = 0.1,
    now: float | None = None,
) -> float:
    similarity = max(0.0, ev.score)
    confidence_mult = KC_FLOOR + (1.0 - KC_FLOOR) * clamp01(ev.knowledge_confidence)
    # Observation-age decay when the record carries a timestamp; supersession (is_stale)
    # still caps the multiplier at STALE_DECAY. Records without a timestamp keep the
    # legacy binary behavior. knowledge_confidence is left untouched on purpose: its
    # server-side recency component tracks *reinforcement* recency, this tracks
    # *observation* age.
    decay = age_decay(
        ev.record.recorded_at if ev.record else None,
        half_life_days=half_life_days,
        floor=decay_floor,
        now=now,
    )
    if decay is None:
        decay = STALE_DECAY if ev.is_stale else 1.0
    elif ev.is_stale:
        decay = min(decay, STALE_DECAY)
    return similarity * confidence_mult * decay


def seed_factor(n_live: int, *, seed_weight: float, crowdout_n: int) -> float:
    """Weight multiplier for seeded evidence, crowded out linearly by live outcomes."""
    if crowdout_n <= 0:
        return seed_weight
    return seed_weight * max(0.0, 1.0 - n_live / float(crowdout_n))


def aggregate_by_model(
    evidence: Iterable[RecalledEvidence],
    candidate_ids: set[str] | None = None,
    *,
    half_life_days: float = 0.0,
    decay_floor: float = 0.1,
    seed_weight: float = 1.0,
    seed_crowdout_n: int = 0,
    recall_vote_min_n: int = 0,
    human_weight: float = 1.0,
    discount_half_life_days: float = 0.0,
    reset_epochs: dict[str, float] | None = None,
    now: float | None = None,
) -> dict[str, ModelAggregate]:
    """Group neighbors by model and accumulate weighted success statistics.

    Two passes: the first counts live (non-seed) outcomes per model so seeded evidence
    can be crowded out as real feedback accumulates; the second accumulates weights.
    ``human_weight`` (clamped to [0, 1]) down-weights caller-asserted ("human") labels
    relative to gate/judge evidence — bounded trust for the one gameable source.
    Defaults preserve legacy behavior (no age decay, seeds at full weight).
    """
    ref_now = now if now is not None else time.time()
    items: list[tuple[RecalledEvidence, OutcomeRecord]] = []
    n_live: dict[str, int] = {}
    for ev in evidence:
        rec = ev.record
        if rec is None:
            continue
        # Unlabeled records carry no quality signal (their outcome means "completed",
        # not "succeeded") — they must never vote on predicted success. Includes
        # legacy pre-v3 records whose persisted quality may have been fabricated.
        if not is_labeled(rec.evidence_source):
            continue
        # Bi-temporal tombstone: an invalidated record (recall track record collapsed)
        # is out of ranking entirely — still readable by audits, never by scoring.
        if rec.invalidated_at is not None:
            continue
        if candidate_ids is not None and rec.model_id not in candidate_ids:
            continue
        # Posterior reset epoch: a record observed before the model's reset (CUSUM
        # drift or provider snapshot change) describes a dead regime — zero weight.
        # A record with no timestamp cannot prove it post-dates the reset; excluded.
        if reset_epochs:
            epoch = reset_epochs.get(rec.model_id)
            if epoch is not None and (rec.recorded_at is None or rec.recorded_at < epoch):
                continue
        items.append((ev, rec))
        if rec.source_dataset is None:
            n_live[rec.model_id] = n_live.get(rec.model_id, 0) + 1

    aggs: dict[str, ModelAggregate] = {}
    kc_totals: dict[str, float] = {}

    for ev, rec in items:
        model_id = rec.model_id

        weight = neighbor_weight(
            ev, half_life_days=half_life_days, decay_floor=decay_floor, now=now
        )
        # Non-stationarity discount (unfloored, unlike the decay inside neighbor_weight):
        # halves per half-life of observation age so the posterior can actually forget.
        if discount_half_life_days > 0.0 and rec.recorded_at is not None and rec.recorded_at > 0:
            age_days = max(0.0, ref_now - rec.recorded_at) / _SECONDS_PER_DAY
            weight *= 0.5 ** (age_days / discount_half_life_days)
        # Recall-track down-weight (experience-following countermeasure): once a record
        # has enough recall votes, its weight scales with how often decisions it was
        # recalled into actually succeeded — floored so bad-track evidence gets cheap,
        # never silently censored.
        if recall_vote_min_n > 0 and rec.recall_n >= recall_vote_min_n:
            weight *= max(RECALL_WEIGHT_FLOOR, rec.recall_success_mass / rec.recall_n)
        if rec.evidence_source == EVIDENCE_HUMAN and human_weight != 1.0:
            weight *= clamp01(human_weight)
        if rec.source_dataset is not None and seed_weight != 1.0:
            weight *= seed_factor(
                n_live.get(model_id, 0), seed_weight=seed_weight, crowdout_n=seed_crowdout_n
            )
        agg = aggs.get(model_id)
        if agg is None:
            agg = ModelAggregate(model_id=model_id)
            aggs[model_id] = agg
            kc_totals[model_id] = 0.0

        if rec.n_outcomes > 0:
            # v4 accumulating record: its counters ARE the history for this
            # (cluster, model) — one success no longer erases fifty prior ones.
            eff_n = float(min(rec.n_outcomes, COUNTER_N_CAP))
            mean_y = clamp01(rec.success_mass / rec.n_outcomes)
            agg.weight_sum += weight * eff_n
            agg.weighted_success += weight * eff_n * mean_y
            agg.n += rec.n_outcomes
        else:
            y = clamp01(label_score(rec.outcome, rec.quality_score))
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


def is_conflicted(agg: ModelAggregate, min_n: int = 4, lo: float = 0.35, hi: float = 0.70) -> bool:
    """A model whose neighbors show mixed success — broadened to catch degrading models."""
    return agg.n >= min_n and lo <= agg.weighted_success_rate <= hi

