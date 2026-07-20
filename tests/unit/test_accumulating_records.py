"""Phase 1b: the durable (cluster, model) record accumulates history across upserts."""

from __future__ import annotations

import pytest

from minima.memory.records import (
    COST_SAMPLE_RING,
    REC_ID_RING,
    OutcomeRecord,
    merged_outcome,
)
from minima.recommender.aggregate import COUNTER_N_CAP, aggregate_by_model
from tests.factories import make_evidence


def _outcome(rec_id: str, *, outcome: str = "success", quality: float | None = None,
             cost: float = 0.002, tokens: int = 500, latency: int = 800) -> OutcomeRecord:
    return OutcomeRecord(
        model_id="claude-haiku-4-5",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        cost_usd=cost,
        output_tokens=tokens,
        latency_ms=latency,
        quality_score=quality,
        outcome=outcome,
        evidence_source="judge",
        recommendation_id=rec_id,
        recorded_at=1_700_000_000.0,
    )


def test_merged_outcome_accumulates_counters_and_rings():
    first = merged_outcome(None, _outcome("r1", quality=0.9))
    assert first.n_outcomes == 1
    assert first.success_mass == pytest.approx(0.9)
    assert first.cost_samples == [0.002]
    assert first.recent_rec_ids == ["r1"]

    second = merged_outcome(first, _outcome("r2", outcome="failure", quality=0.1, cost=0.003))
    assert second.n_outcomes == 2
    assert second.success_mass == pytest.approx(1.0)
    assert second.cost_samples == [0.002, 0.003]
    assert second.recent_rec_ids == ["r1", "r2"]
    # Point-in-time fields describe the LATEST outcome.
    assert second.outcome == "failure"
    assert second.quality_score == pytest.approx(0.1)


def test_merged_outcome_replay_returns_prev_unchanged():
    first = merged_outcome(None, _outcome("r1"))
    replay = merged_outcome(first, _outcome("r1", outcome="failure"))
    assert replay is first
    assert replay.n_outcomes == 1


def test_merged_outcome_rings_are_capped():
    rec = merged_outcome(None, _outcome("r0"))
    for i in range(1, 40):
        rec = merged_outcome(rec, _outcome(f"r{i}", cost=0.001 * (i + 1)))
    assert rec.n_outcomes == 40  # counters keep the FULL history...
    assert len(rec.cost_samples) == COST_SAMPLE_RING  # ...rings stay bounded
    assert len(rec.recent_rec_ids) == REC_ID_RING


def test_merged_outcome_folds_legacy_labeled_record_as_one_unit():
    legacy = _outcome("r-old", quality=0.8)
    legacy.n_outcomes = 0  # pre-v4 record: no counters
    merged = merged_outcome(legacy, _outcome("r-new", quality=0.6))
    assert merged.n_outcomes == 2
    assert merged.success_mass == pytest.approx(0.8 + 0.6)


def test_merged_outcome_ignores_legacy_telemetry_history():
    legacy = _outcome("r-old", quality=0.9)
    legacy.n_outcomes = 0
    legacy.evidence_source = "none"  # pre-v3 record demoted to telemetry — untrusted
    merged = merged_outcome(legacy, _outcome("r-new", quality=0.6))
    assert merged.n_outcomes == 1
    assert merged.success_mass == pytest.approx(0.6)


def test_v4_counters_roundtrip_through_metadata():
    import json

    rec = merged_outcome(None, _outcome("r1", quality=0.9))
    rec = merged_outcome(rec, _outcome("r2", quality=0.7))
    parsed = OutcomeRecord.from_metadata(json.dumps(rec.to_metadata()))
    assert parsed is not None
    assert parsed.n_outcomes == 2
    assert parsed.success_mass == pytest.approx(1.6)
    assert parsed.cost_samples == rec.cost_samples
    assert parsed.recent_rec_ids == ["r1", "r2"]


def test_aggregation_uses_counters_as_evidence_mass():
    ev = make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", score=1.0,
                       knowledge_confidence=1.0)
    rec = ev.record
    assert rec is not None
    rec.n_outcomes = 10
    rec.success_mass = 8.0
    aggs = aggregate_by_model([ev], {"claude-haiku-4-5"})
    agg = aggs["claude-haiku-4-5"]
    # weight = 1.0 (score) * 1.0 (kc) * 1.0 (no decay); mass = weight * n
    assert agg.weight_sum == pytest.approx(10.0)
    assert agg.weighted_success == pytest.approx(8.0)
    assert agg.n == 10


def test_aggregation_caps_single_record_dominance():
    ev = make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", score=1.0,
                       knowledge_confidence=1.0)
    rec = ev.record
    assert rec is not None
    rec.n_outcomes = 500
    rec.success_mass = 400.0
    aggs = aggregate_by_model([ev], {"claude-haiku-4-5"})
    agg = aggs["claude-haiku-4-5"]
    assert agg.weight_sum == pytest.approx(float(COUNTER_N_CAP))
    # The success RATE survives the cap (mass scales with it).
    assert agg.weighted_success_rate == pytest.approx(0.8)


def test_single_record_sample_ring_unlocks_observed_cost():
    ev = make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", score=1.0, cost_usd=0.002)
    rec = ev.record
    assert rec is not None
    rec.n_outcomes = 3
    rec.success_mass = 2.7
    rec.cost_samples = [0.002, 0.0025, 0.003]
    rec.output_token_samples = [400, 500, 600]
    aggs = aggregate_by_model([ev], {"claude-haiku-4-5"})
    agg = aggs["claude-haiku-4-5"]
    # min_n=3 is now reachable from ONE organic durable record — before the rings,
    # the upsert capped every (cluster, model) at a single cost observation.
    assert agg.observed_cost(min_n=3) == pytest.approx(0.0025)
    assert agg.observed_output_tokens(min_n=3) == pytest.approx(500.0)
