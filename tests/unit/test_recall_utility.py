"""F3 learned recall scoring: utility ledger bounds + evidence re-weighting seam."""

from __future__ import annotations

import pytest

from minima.memory.recall_utility import (
    MULT_MAX,
    MULT_MIN,
    RecallUtilityStore,
    apply_recall_utility,
)
from tests.factories import make_evidence


class TestStore:
    def test_untracked_entry_is_neutral(self):
        store = RecallUtilityStore()
        assert store.multiplier("lane", ("e1", None)) == 1.0

    def test_credit_raises_and_debit_lowers_within_bounds(self):
        store = RecallUtilityStore()
        for _ in range(50):
            store.credit("lane", "good")
            store.debit("lane", "bad")
        good = store.multiplier("lane", ("good",))
        bad = store.multiplier("lane", ("bad",))
        assert 1.0 < good <= MULT_MAX
        assert MULT_MIN <= bad < 1.0
        assert good == pytest.approx(MULT_MAX, abs=0.01)
        assert bad == pytest.approx(MULT_MIN, abs=0.01)

    def test_zero_net_is_neutral(self):
        store = RecallUtilityStore()
        store.credit("lane", "e1")
        store.debit("lane", "e1")
        assert store.multiplier("lane", ("e1",)) == pytest.approx(1.0)

    def test_lane_scoped(self):
        store = RecallUtilityStore()
        store.debit("lane-a", "e1", 10.0)
        assert store.multiplier("lane-b", ("e1",)) == 1.0

    def test_reference_id_is_a_fallback_key(self):
        store = RecallUtilityStore()
        store.credit("lane", "ref-1", 10.0)
        assert store.multiplier("lane", ("entry-1", "ref-1")) > 1.0


class TestApply:
    def test_reweights_similarity_in_place(self):
        store = RecallUtilityStore()
        store.debit("lane", "e-bad", 10.0)
        store.credit("lane", "e-good", 10.0)
        bad = make_evidence("m1", 0.9, entry_id="e-bad", score=0.8)
        good = make_evidence("m1", 0.9, entry_id="e-good", score=0.8)
        neutral = make_evidence("m1", 0.9, entry_id="e-neutral", score=0.8)
        apply_recall_utility([bad, good, neutral], "lane", store)
        assert bad.score < 0.8 * 0.6
        assert good.score > 0.8 * 1.4
        assert neutral.score == 0.8

    def test_evidence_weight_only_never_candidate_rank(self):
        # The seam mutates ev.score (aggregation input); records stay untouched.
        store = RecallUtilityStore()
        store.debit("lane", "e1", 10.0)
        ev = make_evidence("m1", 0.9, entry_id="e1", score=0.8)
        before = ev.record
        apply_recall_utility([ev], "lane", store)
        assert ev.record is before
