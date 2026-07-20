"""Calibration (ECE, CUSUM), routing health, and savings accounting."""

from __future__ import annotations

import pytest

from minima.metrics.calibration import (
    calibration_by_task_type,
    cusum_flags,
    routing_health,
)
from minima.metrics.savings import group_rows, summarize
from minima.recommender.decisionlog import Reconciliation
from tests.unit.test_decisionlog import make_decision


def _reconciled(rec_id, predicted, outcome, *, quality=None, cost=None, task_type="code"):
    rec = make_decision(rec_id)
    rec.task_type = task_type
    rec.candidates[0].predicted_success = predicted
    rec.ts = 1_700_000_000.0 + hash(rec_id) % 1000
    update = Reconciliation(
        model_id=rec.chosen_model_id,
        outcome=outcome,
        quality=quality if quality is not None else (0.9 if outcome == "success" else 0.1),
        cost_usd=cost,
        ts=rec.ts + 60,
    )
    rec.realized_model_id = update.model_id
    rec.realized_outcome = update.outcome
    rec.realized_quality = update.quality
    rec.realized_cost_usd = update.cost_usd
    rec.feedback_ts = update.ts
    rec.evidence_source = "judge"
    return rec


class TestCalibration:
    def test_perfectly_calibrated_stream_has_low_ece(self):
        # predicted 0.8 -> 80% success rate, predicted 0.2 -> 20%.
        rows = []
        for i in range(100):
            rows.append(_reconciled(f"h{i}", 0.85, "success" if i % 100 < 85 else "failure"))
        for i in range(100):
            rows.append(_reconciled(f"l{i}", 0.15, "success" if i % 100 < 15 else "failure"))
        reports = calibration_by_task_type(rows)
        global_report = reports[0]
        assert global_report.slice_key == "global"
        assert global_report.n == 200
        assert global_report.ece < 0.05

    def test_overconfident_stream_has_high_ece(self):
        rows = [_reconciled(f"r{i}", 0.95, "failure") for i in range(50)]
        reports = calibration_by_task_type(rows)
        assert reports[0].ece > 0.8

    def test_sparse_slice_shrinks_toward_global(self):
        rows = [_reconciled(f"c{i}", 0.8, "success", task_type="code") for i in range(80)]
        # Tiny, badly calibrated slice: 2 samples must not read as ECE ~1.0.
        rows += [_reconciled(f"q{i}", 0.95, "failure", task_type="qa") for i in range(2)]
        reports = {r.slice_key: r for r in calibration_by_task_type(rows, shrinkage_k=20.0)}
        qa = reports["qa"]
        assert qa.ece > 0.9  # raw is terrible
        assert qa.ece_shrunk < 0.3  # but shrinkage pulls it toward the (good) global

    def test_unreconciled_rows_are_excluded(self):
        rows = [make_decision(f"u{i}") for i in range(10)]
        reports = calibration_by_task_type(rows)
        assert reports[0].n == 0


class TestCusum:
    def test_flags_sustained_overprediction(self):
        rows = [_reconciled(f"d{i}", 0.9, "failure") for i in range(12)]
        flags = cusum_flags(rows)
        assert flags
        assert flags[0].direction == "over_predicting"
        assert flags[0].cluster == "code:hard"

    def test_quiet_on_calibrated_stream(self):
        # predicted 0.8 with a real 80% success rate: routine single failures must
        # NOT trip the detector (this is exactly the over-sensitivity failure mode).
        rows = []
        for i in range(60):
            rows.append(_reconciled(f"c{i}", 0.8, "success" if i % 5 != 0 else "failure"))
        assert cusum_flags(rows) == []


class TestRoutingHealth:
    def test_coverage_and_rates(self):
        rows = [_reconciled("a", 0.8, "success"), _reconciled("b", 0.8, "failure")]
        rows += [make_decision("c"), make_decision("d")]  # no feedback
        rows[2].escalated = True
        # Policy active on two rows, but only one pick actually explored.
        rows[2].policy = "epsilon_softmax"
        rows[3].policy = "epsilon_softmax"
        rows[3].explored = True
        health = routing_health(rows)
        assert health["recommendations"] == 4
        assert health["feedback_coverage"] == 0.5
        assert health["escalation_rate"] == 0.25
        assert health["exploration_share"] == 0.25  # actual exploration picks
        assert health["thompson_policy_share"] == 0.0  # legacy epsilon rows are not thompson

    def test_empty(self):
        assert routing_health([])["recommendations"] == 0


class TestSavings:
    def test_estimated_both_baselines(self):
        rec = make_decision("s1")
        rec.est_cost_recommended = 0.001
        rec.est_cost_premium = 0.05
        rec.baseline_model_id = "gpt-default"
        rec.est_cost_baseline_declared = 0.01
        summary = summarize([rec])
        est = summary.estimated
        assert est.n == 1
        assert est.savings_vs_premium_usd == pytest.approx(0.049)
        assert est.n_declared == 1
        assert est.savings_vs_declared_usd == pytest.approx(0.009)

    def test_realized_uses_actual_cost(self):
        rec = _reconciled("s2", 0.8, "success", cost=0.002)
        rec.est_cost_recommended = 0.001
        rec.est_cost_premium = 0.05
        summary = summarize([rec])
        real = summary.realized
        assert real.n_reconciled == 1
        assert real.realized_cost_usd == pytest.approx(0.002)
        assert real.savings_vs_premium_est_usd == pytest.approx(0.048)

    def test_unreconciled_rows_only_count_estimated(self):
        summary = summarize([make_decision("s3")])
        assert summary.estimated.n == 1
        assert summary.realized.n_reconciled == 0

    def test_group_rows(self):
        a = make_decision("g1")
        b = make_decision("g2")
        b.task_type = "qa"
        groups = group_rows([a, b], "task_type")
        assert set(groups) == {"code", "qa"}
        assert group_rows([a, b], None) == {}
