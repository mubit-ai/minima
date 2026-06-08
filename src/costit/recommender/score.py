"""Scoring: capability prior + memory -> predicted success; cost; slider -> threshold."""

from __future__ import annotations

from costit.memory.records import clamp01
from costit.recommender.types import ModelAggregate
from costit.schemas.common import TaskType
from costit.schemas.models_catalog import ModelCard

_DEFAULT_PRIOR = 0.5


def capability_prior(card: ModelCard, task_type: TaskType) -> float:
    """Prior probability that this model handles this task type well, in [0, 1]."""
    by_type = card.capability_by_task_type.get(task_type)
    if by_type is not None:
        return clamp01(by_type)
    intel = card.capability_priors.get("intelligence_index")
    return clamp01(intel) if intel is not None else _DEFAULT_PRIOR


def predicted_success(
    agg: ModelAggregate | None, prior: float, pseudocount: float
) -> tuple[float, float]:
    """Beta-smoothed success blended with the capability prior.

    Returns ``(predicted_success, confidence)``. With no evidence, predicted success
    falls back to the prior and confidence is 0.
    """
    alpha0 = prior * pseudocount
    beta0 = (1.0 - prior) * pseudocount
    if agg is None or agg.weight_sum <= 0.0:
        return clamp01(prior), 0.0
    p = (agg.weighted_success + alpha0) / (agg.weight_sum + alpha0 + beta0)
    confidence = 1.0 - 1.0 / (1.0 + agg.weight_sum)
    return clamp01(p), clamp01(confidence)


def estimate_cost(
    card: ModelCard, input_tokens: int, output_tokens: int, use_cache: bool = False
) -> tuple[float, dict[str, float]]:
    if use_cache and card.cache_read_cost_per_mtok is not None:
        in_price = card.cache_read_cost_per_mtok
    else:
        in_price = card.input_cost_per_mtok
    cost_in = (input_tokens / 1_000_000.0) * in_price
    cost_out = (output_tokens / 1_000_000.0) * card.output_cost_per_mtok
    breakdown = {"input": round(cost_in, 8), "output": round(cost_out, 8)}
    return cost_in + cost_out, breakdown


def threshold_from_slider(
    cost_quality_tradeoff: float, tau_min: float, tau_max: float, min_quality: float | None = None
) -> float:
    """Map the 0..10 slider to a minimum acceptable predicted-success threshold.

    0 = accept the cheapest model clearing ``tau_min``; 10 = require ``tau_max``.
    """
    cq = max(0.0, min(10.0, cost_quality_tradeoff))
    tau = tau_min + (cq / 10.0) * (tau_max - tau_min)
    if min_quality is not None:
        tau = max(tau, min_quality)
    return tau


def with_exploration_bonus(predicted: float, confidence: float, bonus: float) -> float:
    """Optimistically inflate predicted success for under-explored candidates.

    The bonus is scaled by ``(1 - confidence)`` so well-evidenced models are barely
    touched while models with little/no recalled evidence get the full nudge — enough
    to occasionally clear the threshold and earn a recommendation (and thus feedback).
    ``bonus`` of 0 disables exploration entirely (pure exploitation).
    """
    if bonus <= 0.0:
        return predicted
    return clamp01(predicted + bonus * (1.0 - clamp01(confidence)))


def ranking_score(predicted: float, normalized_cost: float, cost_quality_tradeoff: float) -> float:
    """Smooth blend used to order the returned list (distinct from the hard threshold)."""
    cq = max(0.0, min(10.0, cost_quality_tradeoff))
    lam = 0.3 + 0.07 * cq  # cq=0 -> 0.3 (cost-leaning); cq=10 -> 1.0 (quality-only)
    return lam * predicted - (1.0 - lam) * normalized_cost
