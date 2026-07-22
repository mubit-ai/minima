"""Escalation triggers — DIAGNOSTIC only.

Thin, conflicting, or tied evidence is surfaced to the caller (response warnings +
decision log) so the harness can act on it. The harness owns the honest cascade:
its recovery ladder re-decides after a VERIFIED failure, which strictly dominates
the deleted pre-decision LLM reasoner (a guess made before anything ran).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from minima.config import Settings
from minima.recommender.aggregate import is_conflicted
from minima.recommender.decisionlog import DecisionRecord
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
    recall_confidence: float = 0.0,
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

    # Mubit's own retrieval confidence for the recall that produced the evidence.
    # 0.0 means the server didn't report one (evidence_only recalls may omit it) —
    # only a *reported* low value is a signal; absence is not.
    if 0.0 < recall_confidence < settings.minima_escalation_c_min:
        decision.reasons.append("low_recall_confidence")

    if len(ranked) >= 2:
        gap = ranked[0].score - ranked[1].score
        if gap < settings.minima_escalation_tie_delta:
            decision.reasons.append("tie")

    if any(is_conflicted(agg) for agg in aggregates.values()):
        decision.reasons.append("conflict")

    decision.should_escalate = bool(decision.reasons)
    return decision


def deferral_stats(rows: Iterable[DecisionRecord]) -> dict[str, tuple[int, int]]:
    """Per-cluster ``(recovery_chains, reconciled_rows)`` from decision-log rows.

    A chain is a reconciled decision that arrived as a recovery re-route (its feedback
    carried escalation_reason); the rate chains/reconciled is the cluster's realized
    deferral rate.
    """
    stats: dict[str, tuple[int, int]] = {}
    for rec in rows:
        if rec.realized_outcome is None:
            continue
        chains, total = stats.get(rec.cluster, (0, 0))
        stats[rec.cluster] = (chains + (1 if rec.escalation_reason else 0), total + 1)
    return stats


def deferral_warning(
    stats: dict[str, tuple[int, int]],
    cluster: str,
    *,
    warn_rate: float,
    min_chains: int,
) -> str | None:
    chains, total = stats.get(cluster, (0, 0))
    if total > 0 and chains >= min_chains and chains / total > warn_rate:
        return f"escalation_rate_high:{cluster}"
    return None
