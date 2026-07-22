"""Unit tests for judge length-debias and the PPI rectifier over gate gold labels."""

from __future__ import annotations

import json

from minima.metrics.calibration import calibration_by_task_type, routing_health
from minima.metrics.judge_calibration import (
    LengthBiasModel,
    corrected_quality,
    fit_length_bias,
    judge_bias_stats,
    ppi_by_model,
    ppi_overall,
    ppi_success_rate,
)
from minima.recommender.decisionlog import (
    CandidateSnapshot,
    DecisionRecord,
    MemoryDecisionLog,
    Reconciliation,
    _deserialize,
    _serialize,
)


def _row(
    *,
    rid: str,
    source: str | None,
    outcome: str | None,
    cluster: str = "code:hard",
    task_type: str = "code",
    quality: float | None = None,
    output_tokens: int | None = None,
    chosen: str = "m",
    predicted: float = 0.8,
) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id=rid,
        org_id="default",
        lane="minima:default",
        cluster=cluster,
        task_type=task_type,
        difficulty="hard",
        fingerprint="fp",
        ts=1000.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id=chosen,
                predicted_success=predicted,
                confidence=0.8,
                est_cost_usd=0.001,
                propensity=1.0,
                raw_predicted_success=predicted,
            )
        ],
    )
    if outcome is not None:
        rec.realized_model_id = chosen
        rec.realized_outcome = outcome
        rec.realized_quality = quality
        rec.realized_output_tokens = output_tokens
        rec.feedback_ts = 1001.0
        rec.evidence_source = source
    return rec


def _gate_half_rate(cluster: str = "code:hard") -> list[DecisionRecord]:
    return [
        _row(
            rid=f"g{i}-{cluster}",
            source="gate",
            outcome="success" if i % 2 == 0 else "failure",
            cluster=cluster,
        )
        for i in range(4)
    ]


class TestFitLengthBias:
    def test_recovers_synthetic_slope(self):
        rows = _gate_half_rate()
        for i in range(9):
            t = 100 * (i + 1)
            rows.append(
                _row(
                    rid=f"j{i}",
                    source="judge",
                    outcome="partial",
                    quality=0.2 + 0.0005 * t,
                    output_tokens=t,
                )
            )
        model = fit_length_bias(rows)
        assert model is not None
        assert abs(model.slope - 0.0005) < 1e-9
        assert abs(model.mean_output_tokens - 500.0) < 1e-9
        assert model.n == 9

    def test_returns_none_below_min_n(self):
        rows = _gate_half_rate()
        rows.append(
            _row(rid="j0", source="judge", outcome="success", quality=0.9, output_tokens=100)
        )
        assert fit_length_bias(rows) is None

    def test_returns_none_without_gate_anchor_in_same_cluster(self):
        rows = _gate_half_rate(cluster="qa:easy")
        for i in range(12):
            rows.append(
                _row(
                    rid=f"j{i}",
                    source="judge",
                    outcome="success",
                    quality=0.9,
                    output_tokens=100 * (i + 1),
                )
            )
        assert fit_length_bias(rows) is None

    def test_returns_none_on_zero_length_variance(self):
        rows = _gate_half_rate()
        for i in range(12):
            rows.append(
                _row(rid=f"j{i}", source="judge", outcome="success", quality=0.9, output_tokens=500)
            )
        assert fit_length_bias(rows) is None

    def test_rows_without_quality_or_tokens_are_excluded(self):
        rows = _gate_half_rate()
        for i in range(12):
            rows.append(
                _row(rid=f"jq{i}", source="judge", outcome="success", output_tokens=100 * (i + 1))
            )
            rows.append(_row(rid=f"jt{i}", source="judge", outcome="success", quality=0.9))
        assert fit_length_bias(rows) is None


class TestCorrectedQuality:
    MODEL = LengthBiasModel(slope=0.001, intercept=0.0, mean_output_tokens=500.0, n=20)

    def test_subtracts_length_effect_beyond_mean(self):
        assert abs(corrected_quality(self.MODEL, 0.8, 700) - 0.6) < 1e-9
        assert abs(corrected_quality(self.MODEL, 0.8, 500) - 0.8) < 1e-9

    def test_clamps_to_unit_interval(self):
        assert corrected_quality(self.MODEL, 0.5, 5000) == 0.0
        assert corrected_quality(self.MODEL, 0.5, 0) == 1.0

    def test_missing_tokens_leaves_quality_unchanged(self):
        assert corrected_quality(self.MODEL, 0.7, None) == 0.7


class TestJudgeBiasStats:
    def test_corrected_false_without_a_fit(self):
        stats = judge_bias_stats([])
        assert stats.corrected is False
        assert stats.n_fit == 0
        assert stats.length_coefficient == 0.0

    def test_corrected_true_with_a_fit(self):
        rows = _gate_half_rate()
        for i in range(9):
            t = 100 * (i + 1)
            rows.append(
                _row(
                    rid=f"j{i}",
                    source="judge",
                    outcome="partial",
                    quality=0.2 + 0.0005 * t,
                    output_tokens=t,
                )
            )
        stats = judge_bias_stats(rows)
        assert stats.corrected is True
        assert stats.n_fit == 9
        assert abs(stats.length_coefficient - 0.0005) < 1e-6


class TestPpi:
    def test_rectifier_removes_optimism_bias(self):
        gate = [
            _row(rid=f"g{i}", source="gate", outcome="success" if i < 5 else "failure")
            for i in range(10)
        ]
        judge = [
            _row(rid=f"j{i}", source="judge", outcome="success" if i < 8 else "failure")
            for i in range(10)
        ]
        est = ppi_success_rate(gate, judge)
        assert est is not None
        assert est.raw_judge_value == 0.8
        assert est.value == 0.5  # 0.8 + (0.5 - 0.8)
        assert est.gate_n == 10
        assert est.judge_n == 10
        assert est.interval_width > 0.0

    def test_disjoint_clusters_leave_estimate_uncorrected(self):
        gate = [_row(rid="g0", source="gate", outcome="success", cluster="qa:easy")]
        judge = [
            _row(rid=f"j{i}", source="judge", outcome="success" if i < 3 else "failure")
            for i in range(4)
        ]
        est = ppi_success_rate(gate, judge)
        assert est is not None
        assert est.value == est.raw_judge_value == 0.75
        assert est.gate_n == 0

    def test_none_without_judge_labels(self):
        gate = [_row(rid="g0", source="gate", outcome="success")]
        assert ppi_success_rate(gate, []) is None
        assert ppi_overall(gate) is None

    def test_ppi_by_model_partitions_on_realized_model(self):
        rows = [
            _row(rid=f"ga{i}", source="gate", outcome="success", chosen="a") for i in range(3)
        ]
        rows += [
            _row(rid=f"ja{i}", source="judge", outcome="failure", chosen="a") for i in range(3)
        ]
        rows += [_row(rid="gb0", source="gate", outcome="success", chosen="b")]
        by_model = ppi_by_model(rows)
        assert set(by_model) == {"a"}  # b has no judge labels -> no estimate
        assert by_model["a"].value == 1.0  # 0.0 + (1.0 - 0.0)

    def test_routing_health_surfaces_summary_only_when_computable(self):
        assert "ppi_corrected_success_rate" not in routing_health([])
        gate_only = [_row(rid="g0", source="gate", outcome="success")]
        assert "ppi_corrected_success_rate" not in routing_health(gate_only)
        rows = gate_only + [_row(rid="j0", source="judge", outcome="failure")]
        health = routing_health(rows)
        assert health["ppi_corrected_success_rate"] == 1.0  # 0.0 + (1.0 - 0.0)


class TestEceUsesCorrectedQuality:
    def test_reports_carry_raw_alongside_corrected(self):
        rows = _gate_half_rate()
        for i in range(10):
            t = 100 * (i + 1)
            rows.append(
                _row(
                    rid=f"j{i}",
                    source="judge",
                    outcome="partial",
                    quality=0.25 + 0.0005 * t,
                    output_tokens=t,
                    predicted=0.3 if t <= 500 else 0.9,
                )
            )
        reports = calibration_by_task_type(rows, n_bins=10, shrinkage_k=20.0)
        report = reports[0]
        assert report.slice_key == "global"
        assert report.ece_quality != report.ece_quality_raw

    def test_no_fit_means_corrected_equals_raw(self):
        rows = _gate_half_rate()
        rows.append(
            _row(rid="j0", source="judge", outcome="success", quality=0.9, output_tokens=100)
        )
        reports = calibration_by_task_type(rows, n_bins=10, shrinkage_k=20.0)
        assert reports[0].ece_quality == reports[0].ece_quality_raw


class TestOutputTokensRoundTrip:
    def test_reconcile_stores_output_tokens(self):
        log = MemoryDecisionLog()
        rec = _row(rid="r1", source=None, outcome=None)
        log.put(rec)
        assert log.reconcile(
            "r1",
            Reconciliation(
                model_id="m",
                outcome="success",
                quality=0.9,
                output_tokens=123,
                evidence_source="judge",
            ),
        )
        stored = log.get("r1")
        assert stored is not None
        assert stored.realized_output_tokens == 123

    def test_serialize_round_trip(self):
        rec = _row(
            rid="r1", source="judge", outcome="success", quality=0.9, output_tokens=456
        )
        assert _deserialize(_serialize(rec)).realized_output_tokens == 456

    def test_pre_capture_payloads_deserialize_to_none(self):
        rec = _row(rid="r1", source="judge", outcome="success", quality=0.9, output_tokens=456)
        payload = json.loads(_serialize(rec))
        payload.pop("realized_output_tokens")
        assert _deserialize(json.dumps(payload)).realized_output_tokens is None
