"""Tests for the routing-collapse margin guard and the top_model_share metric."""

from __future__ import annotations

from minima.metrics.calibration import routing_health
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord
from minima.recommender.engine import _optimize
from minima.recommender.types import CandidateScore
from minima.schemas.common import DecisionBasis
from minima.schemas.models_catalog import ModelCard


def _c(
    model_id: str, cost: float, predicted: float, width: float, *, confidence: float = 0.6
) -> CandidateScore:
    return CandidateScore(
        card=ModelCard(
            model_id=model_id, provider="p", input_cost_per_mtok=1, output_cost_per_mtok=1
        ),
        predicted_success=predicted,
        confidence=confidence,
        est_cost_usd=cost,
        est_cost_breakdown={},
        decision_basis=DecisionBasis.memory,
        score=predicted,
        interval_width=width,
    )


# tau-aware: at tau=0.7 the effective margin is collapse_margin * (1 - 0.7) = 0.3 * margin,
# so the optimism term is margin * 0.3 * 0.5 * interval_width = 0.15 * width at margin 1.0.


def test_guard_prefers_cheaper_plausible_when_pick_is_priciest():
    # Only the expensive model strictly clears tau, but the cheap model's wide credible
    # interval could plausibly clear it -> guard should switch to the cheap model.
    # cheap optimistic = 0.66 + 0.15*0.4 = 0.72 >= 0.7.
    cheap = _c("cheap", cost=0.001, predicted=0.66, width=0.4)
    pricey = _c("pricey", cost=0.010, predicted=0.72, width=0.05)
    rec, fallback, _ranked, warnings = _optimize([cheap, pricey], tau=0.7, collapse_margin=1.0)
    assert rec.card.model_id == "cheap"
    assert "collapse_guard_applied" in warnings
    # the strong (strictly-eligible) model becomes the fallback safety net
    assert fallback is not None and fallback.card.model_id == "pricey"


def test_guard_does_not_fire_when_cheap_is_confidently_bad():
    # Cheap model is confidently below tau (narrow interval) -> stays excluded.
    cheap = _c("cheap", cost=0.001, predicted=0.40, width=0.05)
    pricey = _c("pricey", cost=0.010, predicted=0.72, width=0.05)
    rec, _fb, _ranked, warnings = _optimize([cheap, pricey], tau=0.7, collapse_margin=1.0)
    assert rec.card.model_id == "pricey"
    assert "collapse_guard_applied" not in warnings


def test_guard_gentle_at_high_quality_bar():
    # At a HIGH bar (tau=0.92) the tau-aware factor (1-0.92=0.08) shrinks the rescue to
    # almost nothing, so a cheap model 0.06 under tau is NOT rescued -> quality preserved.
    cheap = _c("cheap", cost=0.001, predicted=0.86, width=0.4)  # optimistic ~0.86+0.064=0.924
    pricey = _c("pricey", cost=0.010, predicted=0.95, width=0.05)
    rec, _fb, _ranked, warnings = _optimize([cheap, pricey], tau=0.92, collapse_margin=1.0)
    assert rec.card.model_id == "pricey"
    assert "collapse_guard_applied" not in warnings


def test_guard_disabled_with_zero_margin():
    cheap = _c("cheap", cost=0.001, predicted=0.66, width=0.4)
    pricey = _c("pricey", cost=0.010, predicted=0.72, width=0.05)
    rec, _fb, _ranked, warnings = _optimize([cheap, pricey], tau=0.7, collapse_margin=0.0)
    assert rec.card.model_id == "pricey"  # strict cheapest-eligible (only the pricey one)
    assert "collapse_guard_applied" not in warnings


def test_else_branch_prefers_cheapest_plausible_over_strongest():
    # Nobody strictly clears tau; default would be the strongest (pricey). Guard prefers
    # the cheapest whose optimistic bound clears tau. cheap optimistic = 0.63 + 0.15*0.5 = 0.705.
    cheap = _c("cheap", cost=0.001, predicted=0.63, width=0.5)
    pricey = _c("pricey", cost=0.010, predicted=0.68, width=0.1)  # optimistic 0.695 < 0.7
    rec, _fb, _ranked, warnings = _optimize([cheap, pricey], tau=0.7, collapse_margin=1.0)
    assert rec.card.model_id == "cheap"
    assert "collapse_guard_applied" in warnings
    assert "no_model_meets_threshold" in warnings


def test_guard_inert_at_cold_start_no_evidence():
    # confidence == 0 means no evidence: priors decide, the guard must not rescue a cheap
    # low-prior model over the user's quality preference.
    cheap = _c("cheap", cost=0.001, predicted=0.55, width=1.0, confidence=0.0)
    pricey = _c("pricey", cost=0.010, predicted=0.80, width=1.0, confidence=0.0)
    rec, _fb, _ranked, warnings = _optimize([cheap, pricey], tau=0.7, collapse_margin=0.5)
    assert rec.card.model_id == "pricey"  # strict eligible pick, guard inert
    assert "collapse_guard_applied" not in warnings


def _row(
    rid: str, chosen: str, costs: dict[str, float], outcome: str | None = None
) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id=rid,
        org_id="default",
        lane="l",
        cluster="code:medium",
        task_type="code",
        difficulty="medium",
        fingerprint="fp",
        ts=1.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id=m, predicted_success=0.8, confidence=0.6, est_cost_usd=c, propensity=1.0
            )
            for m, c in costs.items()
        ],
    )
    if outcome is not None:
        rec.realized_model_id = chosen
        rec.realized_outcome = outcome
        rec.realized_quality = 1.0 if outcome == "success" else 0.0
        rec.feedback_ts = 2.0
    return rec


def test_top_model_share_counts_priciest_picks():
    costs = {"cheap": 0.001, "pricey": 0.010}
    rows = [
        _row("a", "pricey", costs),  # picked the priciest
        _row("b", "cheap", costs),  # picked the cheap one
        _row("c", "pricey", costs),  # priciest again
        _row("d", "cheap", costs),
    ]
    assert routing_health(rows)["top_model_share"] == 0.5
    assert routing_health([])["top_model_share"] == 0.0


def test_cost_position_and_cheapest_share():
    costs = {"cheap": 0.001, "mid": 0.005, "pricey": 0.010}
    rows = [
        _row("a", "cheap", costs),  # position 0.0
        _row("b", "pricey", costs),  # position 1.0
        _row("c", "mid", costs),  # position (0.005-0.001)/(0.010-0.001) = 0.4444
    ]
    h = routing_health(rows)
    assert h["cheapest_model_share"] == round(1 / 3, 4)
    assert h["top_model_share"] == round(1 / 3, 4)
    assert abs(h["cost_position"] - 0.4815) < 0.01  # mean of 0, 1, 0.4444


def test_success_rate_over_reconciled():
    costs = {"cheap": 0.001, "pricey": 0.010}
    rows = [
        _row("a", "cheap", costs, outcome="success"),
        _row("b", "cheap", costs, outcome="failure"),
        _row("c", "cheap", costs),  # no feedback -> not counted in success_rate
    ]
    h = routing_health(rows)
    assert h["success_rate"] == 0.5  # 1 success / 2 reconciled
    assert h["feedback_coverage"] == round(2 / 3, 4)
