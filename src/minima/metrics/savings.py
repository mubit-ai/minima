"""Savings accounting over the decision log: estimated and realized, two baselines.

Both counterfactual baselines are always reported side by side and explicitly labeled:
``vs_premium`` (the most expensive scored candidate — generous, overstates savings for
callers who would never have used the premium model) and ``vs_declared`` (the caller's
stated default via RecommendRequest.baseline_model_id — honest, but only present when
callers declare one). Realized figures use the actual cost reported at feedback and are
restricted to the reconciled subset; estimated and realized are never mixed in one number.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.recommender.decisionlog import DecisionRecord


@dataclass(slots=True)
class SavingsEstimated:
    n: int = 0
    cost_recommended_usd: float = 0.0
    cost_premium_usd: float = 0.0
    savings_vs_premium_usd: float = 0.0
    n_declared: int = 0
    cost_declared_usd: float = 0.0
    savings_vs_declared_usd: float = 0.0


@dataclass(slots=True)
class SavingsRealized:
    n_reconciled: int = 0
    realized_cost_usd: float = 0.0
    est_cost_recommended_usd: float = 0.0
    est_cost_premium_usd: float = 0.0
    savings_vs_premium_est_usd: float = 0.0
    n_declared: int = 0
    est_cost_declared_usd: float = 0.0
    savings_vs_declared_est_usd: float = 0.0


@dataclass(slots=True)
class SavingsSummary:
    estimated: SavingsEstimated = field(default_factory=SavingsEstimated)
    realized: SavingsRealized = field(default_factory=SavingsRealized)


def summarize(rows: list[DecisionRecord]) -> SavingsSummary:
    est = SavingsEstimated()
    real = SavingsRealized()
    for r in rows:
        est.n += 1
        est.cost_recommended_usd += r.est_cost_recommended
        est.cost_premium_usd += r.est_cost_premium
        est.savings_vs_premium_usd += r.est_cost_premium - r.est_cost_recommended
        if r.est_cost_baseline_declared is not None:
            est.n_declared += 1
            est.cost_declared_usd += r.est_cost_baseline_declared
            est.savings_vs_declared_usd += (
                r.est_cost_baseline_declared - r.est_cost_recommended
            )
        if r.reconciled and r.realized_cost_usd is not None and r.realized_cost_usd > 0:
            real.n_reconciled += 1
            real.realized_cost_usd += r.realized_cost_usd
            real.est_cost_recommended_usd += r.est_cost_recommended
            real.est_cost_premium_usd += r.est_cost_premium
            # Realized chosen cost against the ESTIMATED premium baseline — the only
            # counterfactual available (the premium model was never run). Labeled "est".
            real.savings_vs_premium_est_usd += r.est_cost_premium - r.realized_cost_usd
            if r.est_cost_baseline_declared is not None:
                real.n_declared += 1
                real.est_cost_declared_usd += r.est_cost_baseline_declared
                real.savings_vs_declared_est_usd += (
                    r.est_cost_baseline_declared - r.realized_cost_usd
                )

    for obj in (est, real):
        for name in obj.__dataclass_fields__:
            value = getattr(obj, name)
            if isinstance(value, float):
                setattr(obj, name, round(value, 8))
    return SavingsSummary(estimated=est, realized=real)


def group_rows(
    rows: list[DecisionRecord], group_by: str | None
) -> dict[str, list[DecisionRecord]]:
    if group_by == "cluster":
        key = lambda r: r.cluster  # noqa: E731
    elif group_by == "task_type":
        key = lambda r: r.task_type  # noqa: E731
    elif group_by == "lane":
        key = lambda r: r.lane  # noqa: E731
    else:
        return {}
    grouped: dict[str, list[DecisionRecord]] = {}
    for r in rows:
        grouped.setdefault(key(r), []).append(r)
    return grouped
