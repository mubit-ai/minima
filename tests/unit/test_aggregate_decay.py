"""Evidence age decay, supersession cap, legacy fallback, and seed crowd-out."""

from __future__ import annotations

import pytest

from minima.recommender.aggregate import (
    KC_FLOOR,
    STALE_DECAY,
    age_decay,
    aggregate_by_model,
    neighbor_weight,
    seed_factor,
)
from tests.factories import make_evidence

NOW = 1_700_000_000.0
DAY = 86_400.0


def _kc_mult(kc: float) -> float:
    return KC_FLOOR + (1.0 - KC_FLOOR) * kc


class TestAgeDecay:
    def test_halves_every_half_life(self):
        assert age_decay(NOW, half_life_days=30, floor=0.0, now=NOW) == pytest.approx(1.0)
        assert age_decay(NOW - 30 * DAY, half_life_days=30, floor=0.0, now=NOW) == pytest.approx(
            0.5
        )
        assert age_decay(NOW - 60 * DAY, half_life_days=30, floor=0.0, now=NOW) == pytest.approx(
            0.25
        )

    def test_floor_bounds_old_evidence(self):
        assert age_decay(NOW - 365 * DAY, half_life_days=30, floor=0.1, now=NOW) == 0.1

    def test_future_timestamp_clamps_to_no_decay(self):
        assert age_decay(NOW + 5 * DAY, half_life_days=30, floor=0.1, now=NOW) == 1.0

    def test_none_without_timestamp_or_half_life(self):
        assert age_decay(None, half_life_days=30, floor=0.1, now=NOW) is None
        assert age_decay(NOW, half_life_days=0.0, floor=0.1, now=NOW) is None


class TestNeighborWeight:
    def test_fresh_record_no_decay(self):
        ev = make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW)
        w = neighbor_weight(ev, half_life_days=30, decay_floor=0.1, now=NOW)
        assert w == pytest.approx(0.8 * _kc_mult(0.7) * 1.0)

    def test_aged_record_decays(self):
        ev = make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW - 30 * DAY)
        w = neighbor_weight(ev, half_life_days=30, decay_floor=0.1, now=NOW)
        assert w == pytest.approx(0.8 * _kc_mult(0.7) * 0.5)

    def test_stale_caps_fresh_record(self):
        # A superseded but recent record still pays the supersession penalty.
        ev = make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW, is_stale=True)
        w = neighbor_weight(ev, half_life_days=30, decay_floor=0.1, now=NOW)
        assert w == pytest.approx(0.8 * _kc_mult(0.7) * STALE_DECAY)

    def test_old_stale_record_keeps_deeper_decay(self):
        ev = make_evidence(
            "m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW - 90 * DAY, is_stale=True
        )
        w = neighbor_weight(ev, half_life_days=30, decay_floor=0.1, now=NOW)
        assert w == pytest.approx(0.8 * _kc_mult(0.7) * 0.125)

    def test_legacy_record_without_timestamp_keeps_binary_behavior(self):
        fresh = make_evidence("m", 0.9, entry_id="e1", score=0.8)
        stale = make_evidence("m", 0.9, entry_id="e2", score=0.8, is_stale=True)
        w_fresh = neighbor_weight(fresh, half_life_days=30, decay_floor=0.1, now=NOW)
        w_stale = neighbor_weight(stale, half_life_days=30, decay_floor=0.1, now=NOW)
        assert w_fresh == pytest.approx(0.8 * _kc_mult(0.7))
        assert w_stale == pytest.approx(0.8 * _kc_mult(0.7) * STALE_DECAY)

    def test_defaults_preserve_legacy_behavior(self):
        # half_life_days=0 (the function default) disables decay even for v2 records.
        ev = make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW - 300 * DAY)
        assert neighbor_weight(ev) == pytest.approx(0.8 * _kc_mult(0.7))


class TestSeedCrowdOut:
    def test_seed_factor_linear_decay(self):
        assert seed_factor(0, seed_weight=0.5, crowdout_n=5) == pytest.approx(0.5)
        assert seed_factor(2, seed_weight=0.5, crowdout_n=5) == pytest.approx(0.3)
        assert seed_factor(5, seed_weight=0.5, crowdout_n=5) == 0.0
        assert seed_factor(9, seed_weight=0.5, crowdout_n=5) == 0.0

    def test_crowdout_disabled_keeps_flat_weight(self):
        assert seed_factor(100, seed_weight=0.5, crowdout_n=0) == 0.5

    def test_aggregate_crowds_out_seeds_as_live_arrives(self):
        seeds = [
            make_evidence(
                "m", 0.9, entry_id=f"s{i}", source_dataset="routerbench", score=0.8
            )
            for i in range(3)
        ]
        live = [make_evidence("m", 0.9, entry_id=f"l{i}", score=0.8) for i in range(5)]

        cold = aggregate_by_model(seeds, {"m"}, seed_weight=0.5, seed_crowdout_n=5)
        warm = aggregate_by_model(seeds + live, {"m"}, seed_weight=0.5, seed_crowdout_n=5)

        live_only = aggregate_by_model(live, {"m"}, seed_weight=0.5, seed_crowdout_n=5)
        # Cold: seeds count at 0.5x. Warm: 5 live outcomes fully crowd seeds out.
        assert cold["m"].weight_sum > 0
        assert warm["m"].weight_sum == pytest.approx(live_only["m"].weight_sum)

    def test_aggregate_defaults_keep_seeds_at_full_weight(self):
        seeds = [
            make_evidence("m", 0.9, entry_id="s1", source_dataset="routerbench", score=0.8)
        ]
        live = [make_evidence("m", 0.9, entry_id="l1", score=0.8)]
        aggs = aggregate_by_model(seeds + live, {"m"})
        assert aggs["m"].weight_sum == pytest.approx(2 * 0.8 * _kc_mult(0.7))
