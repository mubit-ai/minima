"""Off-policy evaluation over the decision log: policy value and regret-vs-oracle.

The Thompson selection policy logs non-degenerate per-decision propensities, which is
what makes counterfactual estimates possible at all. Everything here reads only
TRUSTED-provenance reconciled rows (gate/judge/human labels — never fabricated ones)
and uses the doubly-robust (DR) estimator:

    V_DR(pi) = mean_r [ q_hat(a_pi(r)) + 1{a_log(r) == a_pi(r)} / p_log(a_log(r))
                        * (y_r - q_hat(a_log(r))) ]

where q_hat is the row's logged calibrated predicted_success per candidate (the model
component), y the trusted realized label, and p_log the logged selection propensity
(the correction component). For rows logged under a deterministic policy the
correction only fires when the target agrees with the logged pick — DR degrades
gracefully to the model-based estimate elsewhere (flagged via ``matched_share``).

The oracle here is MODEL-BASED (per-row argmax of logged predicted success): an
upper bound given the system's own beliefs, not ground-truth counterfactuals. It is
labeled as such — the honest online analogue of RouterArena's routing-optimality
until enough stochastic logs accumulate.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord

from .calibration import _trusted_label

# Propensities below this are clipped for the DR correction term (variance control).
_PROPENSITY_CLIP = 0.05


@dataclass(slots=True)
class PolicyEstimate:
    """DR estimate of one target policy over the trusted reconciled log."""

    policy: str
    n: int
    # Estimated per-decision success probability under this policy.
    success_value: float
    # Estimated per-decision cost under this policy (est-cost basis; the logged arm's
    # realized cost substitutes when the target agrees with the logged pick).
    cost_value: float
    # Share of rows where the target's pick equals the logged pick (the correction
    # term only fires there — low share means the estimate leans on the model term).
    matched_share: float


@dataclass(slots=True)
class RegretReport:
    n_trusted: int
    n_total_reconciled: int
    # Share of trusted rows logged with a non-degenerate propensity (< 1.0) on the
    # pick — the fraction of the log that is genuinely counterfactual-capable.
    stochastic_share: float
    policies: list[PolicyEstimate] = field(default_factory=list)
    # Model-based oracle success minus the deployed policy's empirical success.
    regret_vs_oracle: float = 0.0


def _pick(policy: str, row: DecisionRecord) -> CandidateSnapshot | None:
    cands = row.candidates
    if not cands:
        return None
    if policy == "deployed":
        return next((c for c in cands if c.model_id == row.chosen_model_id), None)
    if policy == "map_argmin":
        eligible = [c for c in cands if c.predicted_success >= row.tau]
        pool = eligible or cands
        return min(pool, key=lambda c: (c.est_cost_usd, -c.predicted_success))
    if policy == "always_cheapest":
        return min(cands, key=lambda c: c.est_cost_usd)
    if policy == "always_premium":
        return max(cands, key=lambda c: c.est_cost_usd)
    if policy == "oracle_model_based":
        return max(cands, key=lambda c: c.predicted_success)
    return None


def _logged(row: DecisionRecord) -> CandidateSnapshot | None:
    return next((c for c in row.candidates if c.model_id == row.chosen_model_id), None)


def _dr_estimate(policy: str, rows: list[DecisionRecord]) -> PolicyEstimate | None:
    n = 0
    success_sum = 0.0
    cost_sum = 0.0
    matched = 0
    for row in rows:
        target = _pick(policy, row)
        logged = _logged(row)
        if target is None or logged is None:
            continue
        y = 1.0 if row.realized_outcome == "success" else 0.0
        n += 1
        success = target.predicted_success
        cost = target.est_cost_usd
        if target.model_id == logged.model_id:
            matched += 1
            p = max(_PROPENSITY_CLIP, logged.propensity or 1.0)
            success += (y - logged.predicted_success) / p
            if row.realized_cost_usd is not None and row.realized_cost_usd > 0:
                cost += (row.realized_cost_usd - logged.est_cost_usd) / p
        success_sum += success
        cost_sum += cost
    if n == 0:
        return None
    return PolicyEstimate(
        policy=policy,
        n=n,
        success_value=round(min(1.0, max(0.0, success_sum / n)), 4),
        cost_value=round(max(0.0, cost_sum / n), 8),
        matched_share=round(matched / n, 4),
    )


def regret_report(rows: list[DecisionRecord]) -> RegretReport:
    """DR policy values + model-based regret over the trusted reconciled log."""
    reconciled = [r for r in rows if r.reconciled]
    trusted = [r for r in reconciled if _trusted_label(r) and r.candidates]
    stochastic = sum(
        1
        for r in trusted
        if (c := _logged(r)) is not None and 0.0 < (c.propensity or 0.0) < 1.0
    )
    policies = []
    for name in ("deployed", "map_argmin", "always_cheapest", "always_premium",
                 "oracle_model_based"):
        est = _dr_estimate(name, trusted)
        if est is not None:
            policies.append(est)
    by_name = {p.policy: p for p in policies}
    regret = 0.0
    if "oracle_model_based" in by_name and "deployed" in by_name:
        gap = by_name["oracle_model_based"].success_value - by_name["deployed"].success_value
        regret = round(max(0.0, gap), 4)
    return RegretReport(
        n_trusted=len(trusted),
        n_total_reconciled=len(reconciled),
        stochastic_share=round(stochastic / len(trusted), 4) if trusted else 0.0,
        policies=policies,
        regret_vs_oracle=regret,
    )
