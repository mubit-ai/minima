from __future__ import annotations

from minima.config import Settings
from minima.recommender import escalation
from minima.recommender.decisionlog import DecisionRecord
from minima.recommender.types import CandidateScore, ModelAggregate
from minima.schemas.common import DecisionBasis
from minima.schemas.models_catalog import ModelCard


def _settings() -> Settings:
    return Settings(mubit_api_key="t")


def _cand(model_id: str, *, score: float, success: float = 0.8) -> CandidateScore:
    return CandidateScore(
        card=ModelCard(
            model_id=model_id, provider="p", input_cost_per_mtok=1, output_cost_per_mtok=1
        ),
        predicted_success=success,
        confidence=0.6,
        est_cost_usd=0.001,
        est_cost_breakdown={},
        decision_basis=DecisionBasis.memory,
        score=score,
    )


def test_disallowed_never_escalates():
    d = escalation.evaluate(
        settings=_settings(),
        allow=False,
        total_weight=0.0,
        distinct_models_with_evidence=0,
        recommended_confidence=0.0,
        ranked=[],
        aggregates={},
    )
    assert not d.should_escalate


def test_thin_evidence_triggers():
    d = escalation.evaluate(
        settings=_settings(),
        allow=True,
        total_weight=0.0,
        distinct_models_with_evidence=0,
        recommended_confidence=0.9,
        ranked=[_cand("a", score=0.9)],
        aggregates={},
    )
    assert d.should_escalate
    assert "thin_evidence" in d.reasons


def test_tie_and_conflict_trigger():
    ranked = [_cand("a", score=0.50), _cand("b", score=0.49)]
    aggs = {"a": ModelAggregate(model_id="a", weight_sum=5.0, weighted_success=2.5, n=5)}
    d = escalation.evaluate(
        settings=_settings(),
        allow=True,
        total_weight=5.0,
        distinct_models_with_evidence=5,
        recommended_confidence=0.9,
        ranked=ranked,
        aggregates=aggs,
    )
    assert "tie" in d.reasons
    assert "conflict" in d.reasons


def test_no_triggers_when_strong_and_distinct():
    ranked = [_cand("a", score=0.9), _cand("b", score=0.5)]
    aggs = {
        f"m{i}": ModelAggregate(model_id=f"m{i}", weight_sum=2.0, weighted_success=1.9, n=2)
        for i in range(4)
    }
    d = escalation.evaluate(
        settings=_settings(),
        allow=True,
        total_weight=8.0,
        distinct_models_with_evidence=4,
        recommended_confidence=0.9,
        ranked=ranked,
        aggregates=aggs,
    )
    assert not d.should_escalate


def _strong() -> dict:
    ranked = [_cand("a", score=0.9), _cand("b", score=0.5)]
    aggs = {
        f"m{i}": ModelAggregate(model_id=f"m{i}", weight_sum=2.0, weighted_success=1.9, n=2)
        for i in range(4)
    }
    return {
        "settings": _settings(),
        "allow": True,
        "total_weight": 8.0,
        "distinct_models_with_evidence": 4,
        "recommended_confidence": 0.9,
        "ranked": ranked,
        "aggregates": aggs,
    }


def test_reported_low_recall_confidence_triggers():
    d = escalation.evaluate(**_strong(), recall_confidence=0.2)
    assert "low_recall_confidence" in d.reasons


def test_absent_recall_confidence_is_not_a_signal():
    """0.0 means the server reported nothing (evidence_only recalls may omit it)."""
    d = escalation.evaluate(**_strong(), recall_confidence=0.0)
    assert "low_recall_confidence" not in d.reasons
    assert not d.should_escalate


def _uncertainty_settings() -> Settings:
    return Settings(mubit_api_key="t", minima_escalation_mode="uncertainty")


def _row(cluster: str, *, reconciled: bool = True, reason: str | None = None) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id="r",
        org_id="default",
        lane="minima:default",
        cluster=cluster,
        task_type="code",
        difficulty="hard",
        fingerprint="fp",
        ts=1.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id="m",
        escalated=False,
    )
    if reconciled:
        rec.realized_outcome = "success"
        rec.realized_model_id = "m"
    rec.escalation_reason = reason
    return rec


def test_deferral_stats_counts_chains_per_cluster_reconciled_only():
    rows = [
        _row("code:hard", reason="gate_failed"),
        _row("code:hard", reason="judge_failed"),
        _row("code:hard"),
        _row("code:hard", reconciled=False, reason="gate_failed"),
        _row("qa:easy"),
    ]
    stats = escalation.deferral_stats(rows)
    assert stats == {"code:hard": (2, 3), "qa:easy": (0, 1)}


def test_deferral_warning_requires_rate_and_min_chains():
    assert (
        escalation.deferral_warning(
            {"code:hard": (5, 10)}, "code:hard", warn_rate=0.3, min_chains=5
        )
        == "escalation_rate_high:code:hard"
    )
    # Rate above threshold but too few chains.
    assert (
        escalation.deferral_warning(
            {"code:hard": (4, 5)}, "code:hard", warn_rate=0.3, min_chains=5
        )
        is None
    )
    # Enough chains but rate at/below threshold.
    assert (
        escalation.deferral_warning(
            {"code:hard": (6, 20)}, "code:hard", warn_rate=0.3, min_chains=5
        )
        is None
    )
    assert (
        escalation.deferral_warning({}, "code:hard", warn_rate=0.3, min_chains=5) is None
    )





