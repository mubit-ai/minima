"""Decision log: org scoping, reconciliation, retention, SQLite round-trip."""

from __future__ import annotations

import time

import pytest

from minima.recommender.decisionlog import (
    CandidateSnapshot,
    DecisionRecord,
    MemoryDecisionLog,
    OrgScopedDecisionLog,
    Reconciliation,
    SqliteDecisionLog,
)


def make_decision(
    rec_id: str = "rid-1",
    *,
    org_id: str = "default",
    ts: float = 0.0,
    chosen: str = "claude-haiku-4-5",
    propensities: dict[str, float] | None = None,
    lane: str = "minima:default",
) -> DecisionRecord:
    pi = propensities or {chosen: 1.0}
    return DecisionRecord(
        recommendation_id=rec_id,
        org_id=org_id,
        lane=lane,
        cluster="code:hard",
        task_type="code",
        difficulty="hard",
        fingerprint="f" * 40,
        ts=ts,
        tau=0.7,
        policy="argmin" if pi.get(chosen) == 1.0 else "epsilon_softmax",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id=mid,
                predicted_success=0.8,
                confidence=0.5,
                est_cost_usd=0.001,
                propensity=p,
            )
            for mid, p in pi.items()
        ],
        est_cost_recommended=0.001,
        est_cost_premium=0.05,
    )


@pytest.fixture(params=["memory", "sqlite"])
def backend(request, tmp_path):
    if request.param == "memory":
        return MemoryDecisionLog(retention_days=90)
    return SqliteDecisionLog(str(tmp_path / "decisions.db"), retention_days=90)


class TestBackend:
    def test_put_get_roundtrip(self, backend):
        rec = make_decision("rid-rt", propensities={"a": 0.97, "b": 0.03}, chosen="a")
        backend.put(rec)
        got = backend.get("rid-rt")
        assert got is not None
        assert got.chosen_model_id == "a"
        assert {c.model_id: c.propensity for c in got.candidates} == {"a": 0.97, "b": 0.03}
        assert got.ts > 0  # stamped on put
        assert not got.reconciled

    def test_propensities_sum_to_one(self, backend):
        rec = make_decision("rid-pi", propensities={"a": 0.97, "b": 0.02, "c": 0.01}, chosen="a")
        backend.put(rec)
        got = backend.get("rid-pi")
        assert sum(c.propensity for c in got.candidates) == pytest.approx(1.0)

    def test_reconcile_fills_realized_columns(self, backend):
        backend.put(make_decision("rid-rc"))
        ok = backend.reconcile(
            "rid-rc",
            Reconciliation(
                model_id="claude-haiku-4-5",
                outcome="success",
                quality=0.95,
                cost_usd=0.0021,
                latency_ms=1800,
            ),
        )
        assert ok is True
        got = backend.get("rid-rc")
        assert got.reconciled
        assert got.realized_outcome == "success"
        assert got.realized_cost_usd == 0.0021
        assert got.feedback_ts is not None
        assert got.late_feedback is False

    def test_reconcile_carries_ladder_linkage_and_labeling_metadata(self, backend):
        backend.put(make_decision("rid-a1"))
        ok = backend.reconcile(
            "rid-a1",
            Reconciliation(
                model_id="claude-haiku-4-5",
                outcome="success",
                quality=0.9,
                evidence_source="judge",
                parent_rec_id="rid-parent",
                escalation_reason="gate_failed",
                provider_model_snapshot="claude-haiku-4-5-20251001",
                label_propensity=0.15,
            ),
        )
        assert ok is True
        got = backend.get("rid-a1")
        assert got.parent_rec_id == "rid-parent"
        assert got.escalation_reason == "gate_failed"
        assert got.provider_model_snapshot == "claude-haiku-4-5-20251001"
        assert got.label_propensity == 0.15

    def test_reconcile_defaults_leave_linkage_null(self, backend):
        backend.put(make_decision("rid-a1-null"))
        backend.reconcile(
            "rid-a1-null",
            Reconciliation(model_id="claude-haiku-4-5", outcome="success", quality=None),
        )
        got = backend.get("rid-a1-null")
        assert got.parent_rec_id is None
        assert got.escalation_reason is None
        assert got.provider_model_snapshot is None
        assert got.label_propensity is None

    def test_reconcile_unjudged_stores_null_quality(self, backend):
        # M-J2: UNJUDGED feedback (judged=False) carries quality=None and must be
        # stored straight through as NULL realized_quality — never fabricated to a
        # label-based default. Reconciliation.quality is `float | None` for this.
        backend.put(make_decision("rid-unjudged"))
        ok = backend.reconcile(
            "rid-unjudged",
            Reconciliation(
                model_id="claude-haiku-4-5",
                outcome="success",
                quality=None,
                cost_usd=0.0021,
            ),
        )
        assert ok is True
        got = backend.get("rid-unjudged")
        assert got.reconciled
        assert got.realized_outcome == "success"
        assert got.realized_quality is None
        assert got.realized_cost_usd == 0.0021

    def test_reconcile_unknown_id_returns_false(self, backend):
        assert backend.reconcile("nope", Reconciliation("m", "success", 0.9)) is False

    def test_rows_window_and_lane_filter(self, backend):
        now = time.time()
        backend.put(make_decision("old", ts=now - 1000))
        backend.put(make_decision("new", ts=now - 10))
        backend.put(make_decision("other-lane", ts=now - 10, lane="minima:team-x"))
        rows = backend.rows(since=now - 100)
        assert {r.recommendation_id for r in rows} == {"new", "other-lane"}
        rows = backend.rows(since=now - 100, lane="minima:default")
        assert {r.recommendation_id for r in rows} == {"new"}

    def test_predicted_success_chosen(self, backend):
        backend.put(make_decision("rid-ps"))
        got = backend.get("rid-ps")
        assert got.predicted_success_chosen == pytest.approx(0.8)


class TestOrgScoping:
    def test_cross_org_get_and_reconcile_blocked(self, backend):
        org_a = OrgScopedDecisionLog(backend, "org-a")
        org_b = OrgScopedDecisionLog(backend, "org-b")
        org_a.put(make_decision("rid-a"))

        assert org_a.get("rid-a") is not None
        assert org_b.get("rid-a") is None
        assert org_b.reconcile("rid-a", Reconciliation("m", "success", 0.9)) is False
        assert org_a.reconcile("rid-a", Reconciliation("m", "success", 0.9)) is True

    def test_rows_scoped_per_org(self, backend):
        org_a = OrgScopedDecisionLog(backend, "org-a")
        org_b = OrgScopedDecisionLog(backend, "org-b")
        org_a.put(make_decision("rid-a1"))
        org_a.put(make_decision("rid-a2"))
        org_b.put(make_decision("rid-b1"))
        assert {r.recommendation_id for r in org_a.rows()} == {"rid-a1", "rid-a2"}
        assert {r.recommendation_id for r in org_b.rows()} == {"rid-b1"}


class TestTrustedCorrection:
    def test_telemetry_then_trusted_corrects_the_row(self, backend):
        backend.put(make_decision("rid-corr"))
        assert backend.reconcile(
            "rid-corr",
            Reconciliation(
                model_id="claude-haiku-4-5",
                outcome="success",
                quality=None,
                cost_usd=0.002,
                latency_ms=900,
                evidence_source="none",
            ),
        )
        assert backend.reconcile(
            "rid-corr",
            Reconciliation(
                model_id="claude-haiku-4-5",
                outcome="failure",
                quality=0.1,
                evidence_source="human",
            ),
        )
        got = backend.get("rid-corr")
        assert got.realized_outcome == "failure"
        assert got.realized_quality == 0.1
        assert got.evidence_source == "human"
        # First-reconcile cost/latency survive a correction that omits them.
        assert got.realized_cost_usd == 0.002
        assert got.realized_latency_ms == 900
        assert got.feedback_ts is not None

    def test_legacy_null_evidence_is_correctable(self, backend):
        # Rows reconciled before provenance existed carry evidence_source=None —
        # untrusted, so a trusted verdict may still land.
        backend.put(make_decision("rid-null"))
        assert backend.reconcile(
            "rid-null", Reconciliation("claude-haiku-4-5", "success", None)
        )
        assert backend.reconcile(
            "rid-null",
            Reconciliation("claude-haiku-4-5", "failure", 0.2, evidence_source="gate"),
        )
        assert backend.get("rid-null").realized_outcome == "failure"

    def test_judge_then_human_keeps_first_write(self, backend):
        backend.put(make_decision("rid-judge"))
        assert backend.reconcile(
            "rid-judge",
            Reconciliation("claude-haiku-4-5", "success", 0.9, evidence_source="judge"),
        )
        assert not backend.reconcile(
            "rid-judge",
            Reconciliation("claude-haiku-4-5", "failure", 0.1, evidence_source="human"),
        )
        got = backend.get("rid-judge")
        assert got.realized_outcome == "success"
        assert got.evidence_source == "judge"

    def test_trusted_replay_still_false(self, backend):
        backend.put(make_decision("rid-replay"))
        update = Reconciliation(
            "claude-haiku-4-5", "success", 0.9, cost_usd=0.001, evidence_source="human"
        )
        assert backend.reconcile("rid-replay", update)
        assert not backend.reconcile("rid-replay", update)

    def test_untrusted_replay_still_false(self, backend):
        backend.put(make_decision("rid-telemetry"))
        update = Reconciliation(
            "claude-haiku-4-5", "success", None, evidence_source="none"
        )
        assert backend.reconcile("rid-telemetry", update)
        assert not backend.reconcile("rid-telemetry", update)

    def test_cross_org_correction_blocked(self, backend):
        org_a = OrgScopedDecisionLog(backend, "org-a")
        org_b = OrgScopedDecisionLog(backend, "org-b")
        org_a.put(make_decision("rid-org"))
        assert org_a.reconcile(
            "rid-org",
            Reconciliation("claude-haiku-4-5", "success", None, evidence_source="none"),
        )
        assert not org_b.reconcile(
            "rid-org",
            Reconciliation("claude-haiku-4-5", "failure", 0.1, evidence_source="human"),
        )
        assert org_a.get("rid-org").realized_outcome == "success"
        assert org_a.reconcile(
            "rid-org",
            Reconciliation("claude-haiku-4-5", "failure", 0.1, evidence_source="human"),
        )


def test_retention_purges_on_write(tmp_path):
    backend = SqliteDecisionLog(str(tmp_path / "d.db"), retention_days=1)
    backend.put(make_decision("ancient", ts=time.time() - 10 * 86_400))
    # Purging is throttled (it would otherwise run an O(n) DELETE on every hot-path
    # write); force the throttle window open to observe the purge.
    backend._last_purge = 0.0
    backend.put(make_decision("fresh"))
    assert backend.get("ancient") is None
    assert backend.get("fresh") is not None
