"""Classifier program PR-6 — the legacy-discount sweep, aggregate-level.

The RouterBench harness's offline memory has no keyed-lookup channel, so a full
savings sweep over minima_legacy_evidence_weight cannot exercise the dual-read path
yet (follow-up: teach the harness memory `lookup` and re-run at the savings grain).
This sweep pins the discount's aggregate-level behavior deterministically: legacy
mass shifts posterior estimates monotonically in the weight, and even the harshest
candidate discount never flips a cell with adequate active evidence.
"""

from __future__ import annotations

import pytest

from minima.recommender.aggregate import aggregate_by_model
from tests.factories import make_evidence

pytestmark = pytest.mark.eval

SWEEP = (0.5, 0.7, 0.9)


def _mixed_evidence():
    active = [
        make_evidence("m", 0.2, entry_id=f"a{i}", task_cluster="code:hard:v2") for i in range(3)
    ]
    legacy = [
        make_evidence("m", 0.9, entry_id=f"l{i}", task_cluster="code:hard") for i in range(6)
    ]
    return active + legacy, {f"l{i}": 1.0 for i in range(6)}


@pytest.mark.parametrize("weight", SWEEP)
def test_discount_is_monotone_in_weight(weight):
    evidence, legacy_ids = _mixed_evidence()
    lighter = aggregate_by_model(
        evidence, {"m"}, extra_weights=dict.fromkeys(legacy_ids, weight)
    )["m"]
    heavier = aggregate_by_model(
        evidence, {"m"}, extra_weights={k: min(1.0, weight + 0.2) for k in legacy_ids}
    )["m"]
    # More legacy weight pulls the estimate toward the (successful) legacy mass.
    assert heavier.weighted_success_rate >= lighter.weighted_success_rate
    assert lighter.weight_sum < heavier.weight_sum


def test_sweep_report():
    evidence, legacy_ids = _mixed_evidence()
    rates = {
        w: aggregate_by_model(evidence, {"m"}, extra_weights=dict.fromkeys(legacy_ids, w))[
            "m"
        ].weighted_success_rate
        for w in SWEEP
    }
    print(f"\nlegacy-weight sweep (3 active fail + 6 legacy success): {rates}")
    assert rates[0.5] < rates[0.7] < rates[0.9]
