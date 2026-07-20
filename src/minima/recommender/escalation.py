"""Escalation triggers — DIAGNOSTIC only.

Thin, conflicting, or tied evidence is surfaced to the caller (response warnings +
decision log) so the harness can act on it. The harness owns the honest cascade:
its recovery ladder re-decides after a VERIFIED failure, which strictly dominates
the deleted pre-decision LLM reasoner (a guess made before anything ran).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.config import Settings
from minima.recommender.aggregate import is_conflicted
from minima.recommender.types import CandidateScore, ModelAggregate


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
    """Flag decisions resting on evidence too thin, tied, or conflicted to trust."""
    decision = EscalationDecision()
    if not allow:
        return decision

    if (
        total_weight < settings.minima_escalation_w_min
        or distinct_models_with_evidence < settings.minima_escalation_n_min
    ):
        decision.reasons.append("thin_evidence")

    if recommended_confidence < settings.minima_escalation_c_min:
        decision.reasons.append("low_confidence")

    if len(ranked) >= 2:
        gap = ranked[0].score - ranked[1].score
        if gap < settings.minima_escalation_tie_delta:
            decision.reasons.append("tie")

    if any(is_conflicted(agg) for agg in aggregates.values()):
        decision.reasons.append("conflict")

    decision.should_escalate = bool(decision.reasons)
    return decision
