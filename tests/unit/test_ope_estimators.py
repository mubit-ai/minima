"""PR-C estimator suite: SNIPS/SWITCH/shrinkage, disagreement flag, shadow replay,
non-stationarity discount + posterior resets, and pending-label windowing."""

from __future__ import annotations

import pytest

from minima.metrics.calibration import routing_health
from minima.metrics.ope import regret_report, replay_policy_value
from minima.recommender.aggregate import aggregate_by_model
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord
from minima.recommender.resets import CAUSE_SNAPSHOT_CHANGE, ResetRegistry
from tests.factories import make_evidence

NOW = 1_700_000_000.0
DAY = 86_400.0

CHEAP = "cheap"
PREMIUM = "premium"


def _row(
    rec_id: str,
    *,
    chosen: str,
    outcome: str | None,
    propensities: dict[str, float],
    predicted: dict[str, float] | None = None,
    costs: dict[str, float] | None = None,
    evidence_source: str | None = "judge",
    shadow_choices: dict[str, str] | None = None,
    ts: float = 1.0,
) -> DecisionRecord:
    predicted = predicted or {CHEAP: 0.5, PREMIUM: 0.5}
    costs = costs or {CHEAP: 0.001, PREMIUM: 0.01}
    rec = DecisionRecord(
        recommendation_id=rec_id,
        org_id="default",
        lane="minima:default",
        cluster="code:hard",
        task_type="code",
        difficulty="hard",
        fingerprint="f" * 40,
        ts=ts,
        tau=0.7,
        policy="thompson",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id=mid,
                predicted_success=predicted[mid],
                confidence=0.5,
                est_cost_usd=costs[mid],
                propensity=pi,
            )
            for mid, pi in propensities.items()
        ],
        shadow_choices=shadow_choices,
    )
    if outcome is not None:
        rec.realized_model_id = chosen
        rec.realized_outcome = outcome
        rec.feedback_ts = ts + 60
        rec.evidence_source = evidence_source
    return rec


def _bandit_log(n: int = 200) -> list[DecisionRecord]:
    """Alternating logging over two arms with propensity 0.5 each; cheap truly
    succeeds 30% of the time, premium 90%, while q_hat is a flat (wrong) 0.5."""
    rows = []
    for i in range(n):
        chosen = CHEAP if i % 2 == 0 else PREMIUM
        idx = i // 2
        success = (idx % 10) < (3 if chosen == CHEAP else 9)
        rows.append(
            _row(
                f"r{i}",
                chosen=chosen,
                outcome="success" if success else "failure",
                propensities={CHEAP: 0.5, PREMIUM: 0.5},
            )
        )
    return rows


class TestEstimatorSuite:
    def test_suite_recovers_known_truth_on_synthetic_log(self):
        report = regret_report(_bandit_log())
        cheapest = next(p for p in report.policies if p.policy == "always_cheapest")
        assert set(cheapest.estimates) == {"dr", "snips", "switch", "dr_shrunk"}
        for name, value in cheapest.estimates.items():
            assert value == pytest.approx(0.3, abs=0.12), name
        premium = next(p for p in report.policies if p.policy == "always_premium")
        for name, value in premium.estimates.items():
            assert value == pytest.approx(0.9, abs=0.12), name

    def test_dr_key_matches_headline_success_value(self):
        report = regret_report(_bandit_log())
        for p in report.policies:
            assert p.estimates["dr"] == p.success_value

    def test_no_disagreement_on_consistent_log(self):
        report = regret_report(_bandit_log())
        assert report.estimator_disagreement is False

    def test_disagreement_flag_triggers(self):
        # Ten sure-thing successes (w=1) and ten heavy-weight failures (w=20):
        # per-row DR explodes negative (clamped to 0) while SNIPS self-normalizes
        # to a small positive value — >25% relative disagreement at n=20.
        rows = [
            _row(f"a{i}", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 1.0, PREMIUM: 0.0})
            for i in range(10)
        ] + [
            _row(f"b{i}", chosen=CHEAP, outcome="failure",
                 propensities={CHEAP: 0.05, PREMIUM: 0.95})
            for i in range(10)
        ]
        report = regret_report(rows)
        deployed = next(p for p in report.policies if p.policy == "deployed")
        assert deployed.n == 20
        assert report.estimator_disagreement is True

    def test_disagreement_needs_min_n(self):
        rows = [
            _row("a0", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 1.0, PREMIUM: 0.0}),
            _row("b0", chosen=CHEAP, outcome="failure",
                 propensities={CHEAP: 0.05, PREMIUM: 0.95}),
        ]
        assert regret_report(rows).estimator_disagreement is False


class TestReplayPolicyValue:
    def test_replay_matches_shadow_choice_against_realized(self):
        rows = []
        for i in range(10):
            rows.append(
                _row(
                    f"m{i}",
                    chosen=CHEAP,
                    outcome="success" if i < 6 else "failure",
                    propensities={CHEAP: 0.5, PREMIUM: 0.5},
                    shadow_choices={"discounted": CHEAP, "raw_argmin": PREMIUM},
                )
            )
        est = replay_policy_value(rows, "discounted")
        assert est is not None
        assert est.n == 10
        assert est.n_matched == 10
        assert est.success_value == pytest.approx(0.6)
        # raw_argmin never matched the realized arm -> no weight mass -> None.
        assert replay_policy_value(rows, "raw_argmin") is None

    def test_replay_skips_rows_without_propensity_or_shadow(self):
        rows = [
            _row("p0", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 0.0, PREMIUM: 1.0},
                 shadow_choices={"discounted": CHEAP}),
            _row("p1", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 0.5, PREMIUM: 0.5}),
        ]
        assert replay_policy_value(rows, "discounted") is None

    def test_replay_uses_only_trusted_rows(self):
        rows = [
            _row("t0", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 0.5, PREMIUM: 0.5},
                 shadow_choices={"discounted": CHEAP}, evidence_source="none"),
        ]
        assert replay_policy_value(rows, "discounted") is None


class TestNonStationarityDiscount:
    def test_discount_halves_weight_at_half_life(self):
        fresh = [make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW)]
        aged = [
            make_evidence("m", 0.9, entry_id="e2", score=0.8, recorded_at=NOW - 10 * DAY)
        ]
        w_fresh = aggregate_by_model(
            fresh, discount_half_life_days=10.0, now=NOW
        )["m"].weight_sum
        w_aged = aggregate_by_model(
            aged, discount_half_life_days=10.0, now=NOW
        )["m"].weight_sum
        assert w_aged == pytest.approx(0.5 * w_fresh)

    def test_zero_half_life_disables_discount(self):
        aged = [
            make_evidence("m", 0.9, entry_id="e2", score=0.8, recorded_at=NOW - 10 * DAY)
        ]
        w_off = aggregate_by_model(aged, discount_half_life_days=0.0, now=NOW)[
            "m"
        ].weight_sum
        w_fresh = aggregate_by_model(
            [make_evidence("m", 0.9, entry_id="e1", score=0.8, recorded_at=NOW)],
            discount_half_life_days=0.0,
            now=NOW,
        )["m"].weight_sum
        assert w_off == pytest.approx(w_fresh)


class TestPosteriorResets:
    def test_snapshot_change_stamps_model_wide_reset(self):
        reg = ResetRegistry()
        assert reg.note_snapshot("m", "m-2026-01-01") is False  # first sighting
        assert reg.note_snapshot("m", "m-2026-01-01") is False  # unchanged
        assert reg.note_snapshot("m", "m-2026-06-01") is True  # regime change
        events = reg.active()
        assert len(events) == 1
        assert events[0].model_id == "m"
        assert events[0].cause == CAUSE_SNAPSHOT_CHANGE
        assert reg.epoch_for("m", "any:lane", "any:cluster") == events[0].at

    def test_cusum_stamp_is_first_wins(self):
        reg = ResetRegistry()
        reg.stamp("m", cluster="code:hard", cause="cusum", at=100.0)
        reg.stamp("m", cluster="code:hard", cause="cusum", at=200.0)
        assert reg.epoch_for("m", "lane", "code:hard") == 100.0
        assert reg.epoch_for("m", "lane", "other:cluster") is None

    def test_reset_epoch_excludes_older_records(self):
        evidence = [
            make_evidence("m", 0.9, entry_id="old", score=0.8, recorded_at=NOW - 5 * DAY),
            make_evidence("m", 0.9, entry_id="new", score=0.8, recorded_at=NOW - 1 * DAY),
            make_evidence("m", 0.9, entry_id="untimed", score=0.8, recorded_at=None),
        ]
        aggs = aggregate_by_model(
            evidence, reset_epochs={"m": NOW - 2 * DAY}, now=NOW
        )
        # Only the post-reset record survives; the untimed record cannot prove it
        # post-dates the reset and is excluded too.
        assert aggs["m"].n == 1
        assert [ev.entry_id for ev in aggs["m"].evidence] == ["new"]

    def test_reset_only_hits_the_flagged_model(self):
        evidence = [
            make_evidence("m", 0.9, entry_id="m-old", score=0.8, recorded_at=NOW - 5 * DAY),
            make_evidence("o", 0.9, entry_id="o-old", score=0.8, recorded_at=NOW - 5 * DAY),
        ]
        aggs = aggregate_by_model(evidence, reset_epochs={"m": NOW}, now=NOW)
        assert "m" not in aggs
        assert aggs["o"].n == 1


class TestPendingLabels:
    def test_immature_unreconciled_rows_leave_the_denominator(self):
        rows = [
            _row("done", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 1.0}, ts=NOW - 48 * 3600),
            _row("fresh", chosen=CHEAP, outcome=None,
                 propensities={CHEAP: 1.0}, ts=NOW - 3600),
            _row("stale", chosen=CHEAP, outcome=None,
                 propensities={CHEAP: 1.0}, ts=NOW - 48 * 3600),
        ]
        health = routing_health(rows, now=NOW, label_maturity_hours=24.0)
        assert health["pending_labels"] == 1
        # Denominator: 3 rows minus 1 pending = 2; one reconciled.
        assert health["feedback_coverage"] == 0.5

    def test_zero_maturity_restores_legacy_view(self):
        rows = [
            _row("done", chosen=CHEAP, outcome="success",
                 propensities={CHEAP: 1.0}, ts=NOW - 60),
            _row("fresh", chosen=CHEAP, outcome=None,
                 propensities={CHEAP: 1.0}, ts=NOW - 60),
        ]
        health = routing_health(rows, now=NOW, label_maturity_hours=0.0)
        assert health["pending_labels"] == 0
        assert health["feedback_coverage"] == 0.5
