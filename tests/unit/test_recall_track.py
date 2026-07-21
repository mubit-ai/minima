"""Recall-track (v5): fold/upcast/invalidation + aggregation down-weighting."""

from __future__ import annotations

import pytest

from minima.memory.records import (
    OutcomeRecord,
    fold_recall_vote,
    merged_outcome,
    should_invalidate,
)
from minima.recommender.aggregate import RECALL_WEIGHT_FLOOR, aggregate_by_model
from tests.factories import make_evidence


def _record(**over) -> OutcomeRecord:
    base: dict = {
        "model_id": "m1",
        "task_type": "code",
        "difficulty": "hard",
        "task_cluster": "code:hard",
        "outcome": "success",
        "quality_score": 0.9,
        "evidence_source": "judge",
    }
    base.update(over)
    return OutcomeRecord(**base)


def test_fold_recall_vote_accumulates_and_is_pure():
    rec = _record()
    up = fold_recall_vote(rec, True)
    up = fold_recall_vote(up, False)
    up = fold_recall_vote(up, True)
    assert (up.recall_n, up.recall_success_mass) == (3, 2.0)
    assert (rec.recall_n, rec.recall_success_mass) == (0, 0.0)  # input untouched


def test_fold_recall_vote_weight_default_is_legacy_single_vote():
    rec = fold_recall_vote(_record(), False)
    weighted_default = fold_recall_vote(_record(), False, 1.0)
    assert (rec.recall_n, rec.recall_success_mass) == (1, 0.0)
    assert (weighted_default.recall_n, weighted_default.recall_success_mass) == (1, 0.0)


def test_fold_recall_vote_severity_weight_counts_double():
    rec = fold_recall_vote(_record(), False, 2.0)
    assert (rec.recall_n, rec.recall_success_mass) == (2, 0.0)
    up = fold_recall_vote(rec, True, 2.0)
    assert (up.recall_n, up.recall_success_mass) == (4, 2.0)


def test_fold_recall_vote_weight_floors_at_one_vote():
    rec = fold_recall_vote(_record(), False, 0.1)
    assert rec.recall_n == 1


def test_v4_metadata_upcasts_with_empty_recall_track():
    meta = _record().to_metadata()
    for key in ("recall_n", "recall_success_mass", "invalidated_at"):
        meta.pop(key, None)
    parsed = OutcomeRecord.from_metadata(meta)
    assert parsed is not None
    assert (parsed.recall_n, parsed.recall_success_mass, parsed.invalidated_at) == (0, 0.0, None)


def test_recall_track_roundtrips_through_metadata():
    rec = fold_recall_vote(fold_recall_vote(_record(), True), False)
    rec.invalidated_at = 1_700_000_000.0
    parsed = OutcomeRecord.from_metadata(rec.to_metadata())
    assert parsed is not None
    assert parsed.recall_n == 2
    assert parsed.recall_success_mass == 1.0
    assert parsed.invalidated_at == 1_700_000_000.0


def test_merged_outcome_carries_recall_track_forward():
    prev = fold_recall_vote(fold_recall_vote(_record(), False), False)
    prev.invalidated_at = 123.0
    new = _record(recommendation_id="rec-9")
    merged = merged_outcome(prev, new)
    assert merged.recall_n == 2
    assert merged.recall_success_mass == 0.0
    assert merged.invalidated_at == 123.0


def test_should_invalidate_thresholds():
    ok = _record(recall_n=5, recall_success_mass=3.0)
    bad = _record(recall_n=5, recall_success_mass=0.5)
    thin = _record(recall_n=4, recall_success_mass=0.0)
    dead = _record(recall_n=9, recall_success_mass=0.0, invalidated_at=1.0)
    assert should_invalidate(bad, min_n=5, max_rate=0.2)
    assert not should_invalidate(ok, min_n=5, max_rate=0.2)
    assert not should_invalidate(thin, min_n=5, max_rate=0.2)  # not enough votes yet
    assert not should_invalidate(dead, min_n=5, max_rate=0.2)  # already tombstoned
    assert not should_invalidate(bad, min_n=0, max_rate=0.2)  # feature disabled


def test_aggregate_skips_invalidated_records():
    live = make_evidence("m1", 0.9, entry_id="e1")
    dead = make_evidence("m1", 0.9, entry_id="e2")
    assert dead.record is not None
    dead.record.invalidated_at = 1_700_000_000.0
    aggs = aggregate_by_model([live, dead], {"m1"})
    assert aggs["m1"].n == 1
    assert len(aggs["m1"].evidence) == 1


def test_aggregate_downweights_bad_recall_track_with_floor():
    clean = make_evidence("m1", 0.9, entry_id="e1")
    tracked = make_evidence("m2", 0.9, entry_id="e2")
    assert tracked.record is not None
    tracked.record.recall_n = 10
    tracked.record.recall_success_mass = 4.0  # rate 0.4 > floor 0.25
    hopeless = make_evidence("m3", 0.9, entry_id="e3")
    assert hopeless.record is not None
    hopeless.record.recall_n = 10
    hopeless.record.recall_success_mass = 0.0  # rate 0 -> floored

    aggs = aggregate_by_model([clean, tracked, hopeless], None, recall_vote_min_n=5)
    base = aggs["m1"].weight_sum
    assert aggs["m2"].weight_sum == pytest.approx(base * 0.4)
    assert aggs["m3"].weight_sum == pytest.approx(base * RECALL_WEIGHT_FLOOR)


def test_downweight_needs_min_votes():
    thin = make_evidence("m1", 0.9, entry_id="e1")
    assert thin.record is not None
    thin.record.recall_n = 4
    thin.record.recall_success_mass = 0.0
    clean = make_evidence("m2", 0.9, entry_id="e2")
    aggs = aggregate_by_model([thin, clean], None, recall_vote_min_n=5)
    assert aggs["m1"].weight_sum == aggs["m2"].weight_sum  # below min_n: untouched
