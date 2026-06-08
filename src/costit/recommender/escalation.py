"""When to escalate a recommendation to the cheap-LLM reasoner.

Phase 1 computes the triggers but does not call a reasoner (provider defaults to
``none``); the engine records the reasons as warnings and keeps the deterministic pick.
The reasoner itself is wired in a later phase.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from costit.config import Settings
from costit.recommender.aggregate import is_conflicted
from costit.recommender.types import CandidateScore, ModelAggregate


@dataclass(slots=True)
class EscalationDecision:
    should_escalate: bool = False
    reasons: list[str] = field(default_factory=list)


def evaluate(
    *,
    settings: Settings,
    allow: bool,
    total_weight: float,
    distinct_models_with_evidence: int,
    recommended_confidence: float,
    ranked: list[CandidateScore],
    aggregates: dict[str, ModelAggregate],
) -> EscalationDecision:
    decision = EscalationDecision()
    if not allow:
        return decision

    if (
        total_weight < settings.costit_escalation_w_min
        or distinct_models_with_evidence < settings.costit_escalation_n_min
    ):
        decision.reasons.append("thin_evidence")

    if recommended_confidence < settings.costit_escalation_c_min:
        decision.reasons.append("low_confidence")

    if len(ranked) >= 2:
        gap = ranked[0].score - ranked[1].score
        if gap < settings.costit_escalation_tie_delta:
            decision.reasons.append("tie")

    if any(is_conflicted(agg) for agg in aggregates.values()):
        decision.reasons.append("conflict")

    decision.should_escalate = bool(decision.reasons)
    return decision
