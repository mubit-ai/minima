"""Off-policy evaluation over the decision log: policy value and regret-vs-oracle.

The Thompson selection policy logs non-degenerate per-decision propensities, which is
what makes counterfactual estimates possible at all. Everything here reads only
TRUSTED-provenance reconciled rows (gate/judge/human labels — never fabricated ones).

The headline estimator is doubly-robust (DR):

    V_DR(pi) = mean_r [ q_hat(a_pi(r)) + 1{a_log(r) == a_pi(r)} / p_log(a_log(r))
                        * (y_r - q_hat(a_log(r))) ]

where q_hat is the row's logged calibrated predicted_success per candidate (the model
component), y the trusted realized label, and p_log the logged selection propensity
(the correction component). For rows logged under a deterministic policy the
correction only fires when the target agrees with the logged pick — DR degrades
gracefully to the model-based estimate elsewhere (flagged via ``matched_share``).

Alongside DR, each policy gets a small estimator suite over the same rows (SNIPS,
SWITCH, DR-with-pessimistic-shrinkage); wide disagreement between them on the
deployed policy is surfaced as ``estimator_disagreement`` — the honest "don't trust
one number" flag. MRDR is deliberately NOT implemented: the direct-method term here
is the system's own logged prediction, not a reward model fitted on the logged data,
so there is no model fit for MRDR to re-weight.

The oracle here is MODEL-BASED (per-row argmax of logged predicted success): an
upper bound given the system's own beliefs, not ground-truth counterfactuals. It is
labeled as such — the honest online analogue of RouterArena's routing-optimality
until enough stochastic logs accumulate.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord

from .calibration import _trusted_label

# Propensities below this are clipped for importance-weighted correction terms
# (variance control).
_PROPENSITY_CLIP = 0.05

# Estimator-disagreement gate: flagged when the deployed policy has at least this many
# trusted rows and any two estimates differ by more than this relative margin.
_DISAGREEMENT_MIN_N = 20
_DISAGREEMENT_REL = 0.25

# SWITCH threshold percentile over the logged importance-weight distribution.
_SWITCH_WEIGHT_PERCENTILE = 0.95


@dataclass(slots=True)
class PolicyEstimate:
    """Estimates of one target policy's value over the trusted reconciled log."""

    policy: str
    n: int
    # DR-estimated per-decision success probability under this policy (the headline).
    success_value: float
    # Estimated per-decision cost under this policy (est-cost basis; the logged arm's
    # realized cost substitutes when the target agrees with the logged pick).
    cost_value: float
    # Share of rows where the target's pick equals the logged pick (the correction
    # term only fires there — low share means the estimate leans on the model term).
    matched_share: float
    # Full estimator suite over the same rows: {dr, snips, switch, dr_shrunk}.
    estimates: dict[str, float] = field(default_factory=dict)


@dataclass(slots=True)
class ChallengerEstimate:
    """Replay-matched value of a shadow challenger policy (Li et al. 2011 style).

    Averages realized success/cost over rows where the challenger's logged shadow
    choice equals the model that actually ran, importance-corrected by the logged
    arm's selection propensity (clipped). Rows without propensities are skipped."""

    policy: str
    n: int  # rows carrying this challenger's shadow choice (with usable propensity)
    n_matched: int  # rows where the shadow choice equals the realized model
    success_value: float
    cost_value: float


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
    # True when the deployed policy's estimator suite disagrees beyond the relative
    # margin at n >= the gate — the "no single number is trustworthy here" flag.
    estimator_disagreement: bool = False


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


@dataclass(slots=True)
class _RowView:
    """One trusted row projected against a target policy."""

    y: float
    q_target: float
    q_logged: float
    cost_target: float
    realized_cost: float | None
    cost_logged_est: float
    p: float  # clipped logged propensity
    w: float  # importance weight: 1/p when matched, else 0
    matched: bool


def _views(policy: str, rows: list[DecisionRecord]) -> list[_RowView]:
    out: list[_RowView] = []
    for row in rows:
        target = _pick(policy, row)
        logged = _logged(row)
        if target is None or logged is None:
            continue
        matched = target.model_id == logged.model_id
        p = max(_PROPENSITY_CLIP, logged.propensity or 1.0)
        out.append(
            _RowView(
                y=1.0 if row.realized_outcome == "success" else 0.0,
                q_target=target.predicted_success,
                q_logged=logged.predicted_success,
                cost_target=target.est_cost_usd,
                realized_cost=row.realized_cost_usd,
                cost_logged_est=logged.est_cost_usd,
                p=p,
                w=(1.0 / p) if matched else 0.0,
                matched=matched,
            )
        )
    return out


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def _dr_value(views: list[_RowView]) -> float:
    total = 0.0
    for v in views:
        total += v.q_target + v.w * (v.y - v.q_logged)
    return total / len(views)


def _snips_value(views: list[_RowView]) -> float:
    """Self-normalized IPS: sum(w y) / sum(w). Falls back to the direct-method mean
    when no row matched (SNIPS is undefined without importance weight mass)."""
    w_sum = sum(v.w for v in views)
    if w_sum <= 0.0:
        return sum(v.q_target for v in views) / len(views)
    return sum(v.w * v.y for v in views) / w_sum


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(q * len(ordered))))
    return ordered[idx]


def _switch_value(views: list[_RowView]) -> float:
    """SWITCH: DR where the importance weight is moderate, direct-method where it
    explodes. The threshold is a high percentile of the logged weight distribution."""
    weights = [v.w for v in views if v.w > 0.0]
    if not weights:
        return sum(v.q_target for v in views) / len(views)
    tau = _percentile(weights, _SWITCH_WEIGHT_PERCENTILE)
    total = 0.0
    for v in views:
        if v.w <= tau:
            total += v.q_target + v.w * (v.y - v.q_logged)
        else:
            total += v.q_target
    return total / len(views)


def _shrunk_value(views: list[_RowView]) -> float:
    """DR with per-row pessimistic optimal shrinkage (Su et al. 2020 style).

    Shrunk weight ``w_l = l*w / (w^2 + l)``; the single shrinkage parameter ``l`` is
    chosen from a geometric grid to minimize an estimated MSE: a pessimistic bias
    bound of ``mean(w - w_l)`` (rewards and q_hat live in [0, 1], so |y - q_hat| <= 1)
    plus the sampling variance of the per-row estimates. ``l -> inf`` recovers plain
    DR and ``l = 0`` the pure direct-method estimate, so the grid brackets both."""
    n = len(views)
    weights = [v.w for v in views if v.w > 0.0]
    if not weights:
        return sum(v.q_target for v in views) / n
    w_max = max(weights)

    def estimate(lam: float | None) -> tuple[float, float]:
        """(value, estimated MSE) for one shrinkage level; lam=None means no shrinkage."""
        per_row: list[float] = []
        bias = 0.0
        for v in views:
            if lam is None:
                w_s = v.w
            elif lam <= 0.0:
                w_s = 0.0
            else:
                w_s = lam * v.w / (v.w * v.w + lam)
            bias += v.w - w_s
            per_row.append(v.q_target + w_s * (v.y - v.q_logged))
        bias /= n
        mean = sum(per_row) / n
        var = sum((x - mean) ** 2 for x in per_row) / (n * max(1, n - 1))
        return mean, bias * bias + var

    grid: list[float | None] = [0.0, None]
    lam = max(1e-6, w_max * w_max / 1000.0)
    ceiling = w_max * w_max * 1000.0
    while lam <= ceiling:
        grid.append(lam)
        lam *= 4.0
    best_value, best_mse = None, None
    for candidate in grid:
        value, mse = estimate(candidate)
        if best_mse is None or mse < best_mse:
            best_value, best_mse = value, mse
    assert best_value is not None
    return best_value


def _estimate_policy(policy: str, rows: list[DecisionRecord]) -> PolicyEstimate | None:
    views = _views(policy, rows)
    if not views:
        return None
    n = len(views)
    cost_sum = 0.0
    for v in views:
        cost = v.cost_target
        if v.matched and v.realized_cost is not None and v.realized_cost > 0:
            cost += (v.realized_cost - v.cost_logged_est) * v.w
        cost_sum += cost
    dr = _clamp01(_dr_value(views))
    estimates = {
        "dr": round(dr, 4),
        "snips": round(_clamp01(_snips_value(views)), 4),
        "switch": round(_clamp01(_switch_value(views)), 4),
        "dr_shrunk": round(_clamp01(_shrunk_value(views)), 4),
    }
    return PolicyEstimate(
        policy=policy,
        n=n,
        success_value=round(dr, 4),
        cost_value=round(max(0.0, cost_sum / n), 8),
        matched_share=round(sum(1 for v in views if v.matched) / n, 4),
        estimates=estimates,
    )


def _disagrees(estimate: PolicyEstimate) -> bool:
    if estimate.n < _DISAGREEMENT_MIN_N:
        return False
    values = list(estimate.estimates.values())
    for i, a in enumerate(values):
        for b in values[i + 1 :]:
            m = max(a, b)
            if m > 0.0 and abs(a - b) / m > _DISAGREEMENT_REL:
                return True
    return False


def replay_policy_value(
    rows: list[DecisionRecord], policy_name: str
) -> ChallengerEstimate | None:
    """Replay-matched value of a logged shadow challenger (self-normalized).

    Uses only trusted reconciled rows whose decision carries this challenger's
    shadow choice AND a usable logged propensity; value averages the realized label
    (and cost) over rows where the shadow choice equals the model that actually ran,
    weighted by 1/propensity of the logged arm (clipped as everywhere else)."""
    n = 0
    n_matched = 0
    w_sum = 0.0
    y_sum = 0.0
    cost_sum = 0.0
    for row in rows:
        if not row.reconciled or not _trusted_label(row) or not row.candidates:
            continue
        choice = (row.shadow_choices or {}).get(policy_name)
        if not choice:
            continue
        realized_id = row.realized_model_id or row.chosen_model_id
        logged = next((c for c in row.candidates if c.model_id == realized_id), None)
        if logged is None or not logged.propensity or logged.propensity <= 0.0:
            continue
        n += 1
        if choice != realized_id:
            continue
        n_matched += 1
        w = 1.0 / max(_PROPENSITY_CLIP, logged.propensity)
        w_sum += w
        y_sum += w * (1.0 if row.realized_outcome == "success" else 0.0)
        cost = (
            row.realized_cost_usd
            if row.realized_cost_usd is not None and row.realized_cost_usd > 0
            else logged.est_cost_usd
        )
        cost_sum += w * cost
    if n == 0 or w_sum <= 0.0:
        return None
    return ChallengerEstimate(
        policy=policy_name,
        n=n,
        n_matched=n_matched,
        success_value=round(_clamp01(y_sum / w_sum), 4),
        cost_value=round(max(0.0, cost_sum / w_sum), 8),
    )


def regret_report(rows: list[DecisionRecord]) -> RegretReport:
    """Policy-value estimator suite + model-based regret over the trusted log."""
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
        est = _estimate_policy(name, trusted)
        if est is not None:
            policies.append(est)
    by_name = {p.policy: p for p in policies}
    regret = 0.0
    if "oracle_model_based" in by_name and "deployed" in by_name:
        gap = by_name["oracle_model_based"].success_value - by_name["deployed"].success_value
        regret = round(max(0.0, gap), 4)
    deployed = by_name.get("deployed")
    return RegretReport(
        n_trusted=len(trusted),
        n_total_reconciled=len(reconciled),
        stochastic_share=round(stochastic / len(trusted), 4) if trusted else 0.0,
        policies=policies,
        regret_vs_oracle=regret,
        estimator_disagreement=_disagrees(deployed) if deployed is not None else False,
    )
