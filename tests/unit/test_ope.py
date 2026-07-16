"""Phase 2: doubly-robust policy values + regret-vs-oracle over the decision log."""

from __future__ import annotations

import pytest

from minima.metrics.ope import regret_report
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord, Reconciliation
from minima.recommender.decisionlog import _apply as apply_reconciliation


def _row(
    rec_id: str,
    *,
    chosen: str,
    outcome: str,
    candidates: dict[str, tuple[float, float, float]],
    evidence_source: str | None = "judge",
    tau: float = 0.7,
) -> DecisionRecord:
    """candidates: model_id -> (predicted_success, est_cost_usd, propensity)."""
    rec = DecisionRecord(
        recommendation_id=rec_id,
        org_id="default",
        lane="minima:default",
        cluster="code:hard",
        task_type="code",
        difficulty="hard",
        fingerprint="f" * 40,
        ts=1.0,
        tau=tau,
        policy="thompson",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id=mid,
                predicted_success=p,
                confidence=0.5,
                est_cost_usd=cost,
                propensity=pi,
            )
            for mid, (p, cost, pi) in candidates.items()
        ],
    )
    rec.realized_model_id = chosen
    rec.realized_outcome = outcome
    rec.feedback_ts = 2.0
    rec.evidence_source = evidence_source
    return rec


CANDS = {
    "cheap": (0.6, 0.001, 0.7),
    "premium": (0.9, 0.01, 0.3),
}


def test_regret_report_basic_shape_and_oracle_bound():
    rows = [
        _row("r1", chosen="cheap", outcome="success", candidates=CANDS),
        _row("r2", chosen="cheap", outcome="failure", candidates=CANDS),
        _row("r3", chosen="premium", outcome="success", candidates=CANDS),
    ]
    report = regret_report(rows)
    assert report.n_trusted == 3
    assert report.n_total_reconciled == 3
    assert report.stochastic_share == 1.0  # every pick logged with propensity < 1
    by_name = {p.policy: p for p in report.policies}
    assert set(by_name) == {
        "deployed",
        "map_argmin",
        "always_cheapest",
        "always_premium",
        "oracle_model_based",
    }
    # The model-based oracle upper-bounds the deployed estimate by construction.
    assert by_name["oracle_model_based"].success_value >= by_name["deployed"].success_value
    assert report.regret_vs_oracle >= 0.0
    # Cost ordering sanity: always_premium costs more than always_cheapest.
    assert by_name["always_premium"].cost_value > by_name["always_cheapest"].cost_value
    # Deployed policy matches the log on every row.
    assert by_name["deployed"].matched_share == 1.0


def test_untrusted_rows_are_excluded():
    rows = [
        _row("r1", chosen="cheap", outcome="success", candidates=CANDS),
        _row("r2", chosen="cheap", outcome="success", candidates=CANDS, evidence_source=None),
        _row("r3", chosen="cheap", outcome="success", candidates=CANDS, evidence_source="none"),
    ]
    report = regret_report(rows)
    assert report.n_total_reconciled == 3
    assert report.n_trusted == 1


def test_dr_correction_pulls_toward_realized_labels():
    # The log says predicted 0.9 for premium, but every realized outcome is failure:
    # the DR correction must pull the deployed estimate well below the model term.
    rows = [
        _row(f"r{i}", chosen="premium", outcome="failure", candidates=CANDS)
        for i in range(20)
    ]
    report = regret_report(rows)
    deployed = next(p for p in report.policies if p.policy == "deployed")
    assert deployed.success_value < 0.5  # model term alone would say 0.9


def test_reconcile_replay_guard_first_write_wins():
    rec = _row("r1", chosen="cheap", outcome="success", candidates=CANDS)
    rec.realized_model_id = None
    rec.realized_outcome = None
    first = Reconciliation(
        model_id="cheap", outcome="success", quality=0.9, cost_usd=0.001, ts=2.0,
        evidence_source="judge",
    )
    assert apply_reconciliation(rec, first) is True
    replay = Reconciliation(
        model_id="cheap", outcome="failure", quality=0.0, cost_usd=0.5, ts=3.0,
        evidence_source="judge",
    )
    assert apply_reconciliation(rec, replay) is False
    assert rec.realized_outcome == "success"
    assert rec.realized_cost_usd == pytest.approx(0.001)
    # A DIVERGENT model is a correction, not a replay — allowed through.
    divergent = Reconciliation(
        model_id="premium", outcome="failure", quality=None, cost_usd=0.01, ts=4.0,
        evidence_source="judge",
    )
    assert apply_reconciliation(rec, divergent) is True
    assert rec.realized_model_id == "premium"


def test_calibration_pairs_with_the_realized_model_on_divergence():
    rec = _row("r1", chosen="cheap", outcome="failure", candidates=CANDS)
    rec.realized_model_id = "premium"  # caller ran a different model than recommended
    # The pairing must use PREMIUM's prediction (0.9), not cheap's (0.6).
    assert rec.predicted_success_realized == pytest.approx(0.9)
    rec.realized_model_id = "not-in-candidates"
    assert rec.predicted_success_realized is None  # unpairable -> excluded from fits
