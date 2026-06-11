from __future__ import annotations

from minima.config import Settings
from minima.recommender import escalation
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


def _uncertainty_settings() -> Settings:
    return Settings(mubit_api_key="t", minima_escalation_mode="uncertainty")


def test_uncertainty_mode_wide_interval_triggers():
    d = escalation.evaluate(
        settings=_uncertainty_settings(),
        allow=True,
        total_weight=8.0,  # heavy by legacy standards — must NOT trigger thin_evidence
        distinct_models_with_evidence=4,
        recommended_confidence=0.9,
        ranked=[_cand("a", score=0.9), _cand("b", score=0.5)],
        aggregates={},
        recommended_interval_width=0.4,
    )
    assert d.should_escalate
    assert d.reasons == ["wide_interval"]


def test_uncertainty_mode_narrow_interval_replaces_legacy_pair():
    # Legacy would fire thin_evidence + low_confidence here; the interval gate says
    # the recommended candidate is well-estimated, so neither fires.
    d = escalation.evaluate(
        settings=_uncertainty_settings(),
        allow=True,
        total_weight=0.0,
        distinct_models_with_evidence=0,
        recommended_confidence=0.1,
        ranked=[_cand("a", score=0.9), _cand("b", score=0.5)],
        aggregates={},
        recommended_interval_width=0.1,
    )
    assert not d.should_escalate


def test_uncertainty_mode_keeps_conflict_as_hard_override():
    aggs = {"a": ModelAggregate(model_id="a", weight_sum=5.0, weighted_success=2.5, n=5)}
    d = escalation.evaluate(
        settings=_uncertainty_settings(),
        allow=True,
        total_weight=5.0,
        distinct_models_with_evidence=5,
        recommended_confidence=0.9,
        ranked=[_cand("a", score=0.9), _cand("b", score=0.5)],
        aggregates=aggs,
        recommended_interval_width=0.1,
    )
    assert d.should_escalate
    assert d.reasons == ["conflict"]


def test_legacy_mode_ignores_interval_width():
    d = escalation.evaluate(
        settings=_settings(),  # legacy mode (default)
        allow=True,
        total_weight=8.0,
        distinct_models_with_evidence=4,
        recommended_confidence=0.9,
        ranked=[_cand("a", score=0.9), _cand("b", score=0.5)],
        aggregates={},
        recommended_interval_width=0.99,
    )
    assert not d.should_escalate
