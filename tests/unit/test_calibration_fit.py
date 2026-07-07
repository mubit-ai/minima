"""Unit tests for the isotonic calibration fit applied to predicted_success."""

from __future__ import annotations

from minima.metrics.calibration import (
    CalibratorSet,
    _isotonic_pav,
    fit_calibrators,
)
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord


def _reconciled_row(
    *,
    rid: str,
    task_type: str,
    chosen: str,
    raw_predicted: float,
    outcome: str,
) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id=rid,
        org_id="default",
        lane="minima:default",
        cluster=f"{task_type}:medium",
        task_type=task_type,
        difficulty="medium",
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
                predicted_success=raw_predicted,
                confidence=0.8,
                est_cost_usd=0.001,
                propensity=1.0,
                raw_predicted_success=raw_predicted,
            )
        ],
    )
    rec.realized_model_id = chosen
    rec.realized_outcome = outcome
    rec.realized_quality = 1.0 if outcome == "success" else 0.0
    rec.feedback_ts = 1001.0
    return rec


def test_isotonic_pav_is_monotonic():
    xs, ys = _isotonic_pav([(0.2, 0.0), (0.4, 0.0), (0.6, 1.0), (0.8, 1.0)])
    assert xs == sorted(xs)
    assert ys == sorted(ys)  # non-decreasing
    assert all(0.0 <= y <= 1.0 for y in ys)


def test_isotonic_pav_pools_violators():
    # A dip in the middle must be pooled into a flat (non-decreasing) fit.
    xs, ys = _isotonic_pav([(0.1, 1.0), (0.2, 0.0)])
    assert ys == sorted(ys)
    assert ys[0] == ys[-1] == 0.5  # the two points pool to their mean


def test_fit_returns_none_below_min_n():
    rows = [
        _reconciled_row(
            rid=f"r{i}", task_type="code", chosen="m", raw_predicted=0.9, outcome="success"
        )
        for i in range(5)
    ]
    assert fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=2000.0) is None


def test_overconfident_predictor_is_pulled_down():
    # 100 rows: the model was predicted at 0.9 but only succeeded half the time.
    rows = [
        _reconciled_row(
            rid=f"r{i}",
            task_type="code",
            chosen="m",
            raw_predicted=0.9,
            outcome="success" if i % 2 == 0 else "failure",
        )
        for i in range(100)
    ]
    cal = fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=2000.0)
    assert isinstance(cal, CalibratorSet)
    calibrated = cal.transform("code", 0.9)
    assert calibrated < 0.9  # truthful probability is lower than the inflated prediction
    # Shrinkage keeps it above the raw realized 0.5 (n=100, k=20 -> weight ~0.83).
    assert 0.5 < calibrated < 0.9


def test_unknown_task_type_falls_back_to_global():
    rows = [
        _reconciled_row(
            rid=f"r{i}",
            task_type="code",
            chosen="m",
            raw_predicted=0.9,
            outcome="failure",
        )
        for i in range(60)
    ]
    cal = fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=2000.0)
    assert cal is not None
    # A task_type with no slice-specific map still gets the global correction.
    assert cal.transform("summarization", 0.9) == cal.global_map.transform(0.9)


def test_back_compat_rows_without_raw_use_predicted():
    # Old rows have raw_predicted_success=None; the fit falls back to predicted_success.
    rows = []
    for i in range(40):
        r = _reconciled_row(
            rid=f"r{i}", task_type="qa", chosen="m", raw_predicted=0.8, outcome="failure"
        )
        r.candidates[0].raw_predicted_success = None  # simulate a pre-calibration row
        rows.append(r)
    cal = fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=2000.0)
    assert cal is not None
    assert cal.transform("qa", 0.8) < 0.8
