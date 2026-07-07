"""When to escalate a recommendation to the cheap-LLM reasoner.

Phase 1 computes the triggers but does not call a reasoner (provider defaults to
``none``); the engine records the reasons as warnings and keeps the deterministic pick.
The reasoner itself is wired in a later phase.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.config import Settings
from minima.recommender.aggregate import is_conflicted
from minima.recommender.types import CandidateScore, ModelAggregate
from minima.schemas.common import TaskType


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
    recommended_interval_width: float | None = None,
    recommended_predicted_success: float = 0.0,
    tau: float = 0.0,
    classification_task_type: TaskType | None = None,
    classification_confidence: float = 0.0,
    classification_easy_route: bool = False,
) -> EscalationDecision:
    """Decide whether the cheap-LLM reasoner should be consulted.

    Two modes. "legacy": four independent heuristics. "uncertainty": a single
    posterior-interval-width gate on the recommended candidate replaces the
    thin_evidence + low_confidence pair (the interval IS the principled "how little do
    we know" statistic); conflict stays as a hard override and tie is kept because it
    captures rank instability between candidates that the per-candidate interval
    doesn't see. Every escalation is a paid reasoner call — fewer, better-targeted
    triggers are the efficiency lever.
    """
    decision = EscalationDecision()
    if not allow:
        return decision

    if (
        settings.minima_reasoner_skip_confident_classifications
        and classification_easy_route
        and classification_confidence >= settings.minima_reasoner_confidence_skip_threshold
        and classification_task_type in {
            TaskType.summarization,
            TaskType.extraction,
            TaskType.classification,
            TaskType.translation,
        }
    ):
        return decision

    uncertainty_mode = settings.minima_escalation_mode.lower() == "uncertainty"
    if uncertainty_mode and recommended_interval_width is not None:
        if recommended_interval_width > settings.minima_escalation_interval_width:
            decision.reasons.append("wide_interval")
    else:
        if (
            total_weight < settings.minima_escalation_w_min
            or distinct_models_with_evidence < settings.minima_escalation_n_min
        ):
            decision.reasons.append("thin_evidence")

        if recommended_confidence < settings.minima_escalation_c_min:
            decision.reasons.append("low_confidence")

    near_delta = settings.minima_escalation_near_threshold_delta
    if (
        near_delta > 0
        and tau > 0
        and recommended_predicted_success > 0
        and recommended_confidence > 0.2  # only when there's actual evidence, not a cold prior
        and (recommended_predicted_success - tau) < near_delta
    ):
        decision.reasons.append("near_threshold")

    if len(ranked) >= 2:
        gap = ranked[0].score - ranked[1].score
        if gap < settings.minima_escalation_tie_delta:
            decision.reasons.append("tie")

    if any(is_conflicted(agg) for agg in aggregates.values()):
        decision.reasons.append("conflict")

    decision.should_escalate = bool(decision.reasons)
    return decision
