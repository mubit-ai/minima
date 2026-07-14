"""Repeatable, deterministic assertions that the Phase 0/1 mechanisms improve the metrics.

These lock in the demonstration in examples/metrics_demo.py as regression guarantees.
"""

from __future__ import annotations

import random

from minima.metrics.calibration import _ece, fit_calibrators
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord
from minima.recommender.engine import _optimize
from minima.recommender.types import CandidateScore
from minima.schemas.common import DecisionBasis
from minima.schemas.models_catalog import ModelCard


def _decision(rid: str, raw: float, outcome: str) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id=rid,
        org_id="d",
        lane="l",
        cluster="code:medium",
        task_type="code",
        difficulty="medium",
        fingerprint="fp",
        ts=1.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id="m",
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id="m",
                predicted_success=raw,
                confidence=0.6,
                est_cost_usd=0.001,
                propensity=1.0,
                raw_predicted_success=raw,
            )
        ],
    )
    rec.realized_model_id = "m"
    rec.realized_outcome = outcome
    rec.realized_quality = 1.0 if outcome == "success" else 0.0
    rec.feedback_ts = 2.0
    rec.evidence_source = "judge"
    return rec


def test_calibration_reduces_ece():
    rng = random.Random(7)
    rows = []
    for i in range(2000):
        raw = rng.uniform(0.5, 0.99)
        true_p = max(0.0, raw - 0.2)  # overconfident by 0.2
        outcome = "success" if rng.random() < true_p else "failure"
        rows.append(_decision(f"r{i}", raw, outcome))
    cal = fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=0.0)
    assert cal is not None
    pairs = [
        (r.raw_predicted_success_chosen or 0.0, 1.0 if r.realized_outcome == "success" else 0.0)
        for r in rows
    ]
    ece_before, _ = _ece(pairs, 10)
    ece_after, _ = _ece([(cal.transform("code", p), y) for p, y in pairs], 10)
    assert ece_before > 0.1  # the raw model really is badly miscalibrated
    assert ece_after < ece_before * 0.25  # remap removes most of the error
    assert ece_after < 0.05


def _cand(model_id: str, cost: float, predicted: float, width: float) -> CandidateScore:
    return CandidateScore(
        card=ModelCard(
            model_id=model_id, provider="p", input_cost_per_mtok=1, output_cost_per_mtok=1
        ),
        predicted_success=predicted,
        confidence=0.6,
        est_cost_usd=cost,
        est_cost_breakdown={},
        decision_basis=DecisionBasis.memory,
        score=predicted,
        interval_width=width,
    )


def _collapse_run(margin: float) -> tuple[float, float, float]:
    rng = random.Random(11)
    picked_top = 0
    cost_sum = 0.0
    successes = 0
    n = 2000
    cheap_true, pricey_true = 0.80, 0.95
    for _ in range(n):
        cheap = _cand("cheap", 0.001, rng.uniform(0.78, 0.88), 0.20)
        pricey = _cand("pricey", 0.010, rng.uniform(0.90, 0.98), 0.05)
        rec, _fb, _ranked, _w = _optimize([cheap, pricey], tau=0.85, collapse_margin=margin)
        picked_top += 1 if rec.card.model_id == "pricey" else 0
        cost_sum += rec.est_cost_usd
        true_p = pricey_true if rec.card.model_id == "pricey" else cheap_true
        successes += 1 if rng.random() < true_p else 0
    return picked_top / n, cost_sum / n, successes / n


def test_collapse_guard_cuts_cost_without_sacrificing_quality():
    # Default tau-aware margin (1.0). At a HIGH bar (tau=0.85) the guard must reduce collapse
    # and cost while keeping the realized-success drop SMALL (the quality-retention threshold).
    off_top, off_cost, off_succ = _collapse_run(margin=0.0)
    on_top, on_cost, on_succ = _collapse_run(margin=1.0)
    assert off_top > 0.6  # without the guard, collapse to the priciest model
    assert on_top < off_top * 0.9  # guard meaningfully reduces priciest-model picks
    assert on_cost < off_cost  # and lowers mean spend
    # Quality-retention threshold: tau-aware scaling keeps the success drop <= 3pp at a high
    # bar (the non-tau-aware guard cost ~7.9pp — this is the fix).
    assert (off_succ - on_succ) <= 0.03
