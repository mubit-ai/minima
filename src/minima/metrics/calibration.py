"""Calibration and routing-health metrics over the decision log.

Pure functions over reconciled ``DecisionRecord`` rows — no state of their own, so the
same code powers the tenant-scoped ``GET /v1/calibration`` endpoint and the ops-side
``minima-calibration-report`` console script.

A recommendation is "reconciled" once feedback arrived; only reconciled rows carry a
realized label. Calibration compares the chosen candidate's predicted_success at
decision time against that label (success=1 primary; quality-weighted alongside).
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field

from minima.memory.records import clamp01
from minima.recommender.decisionlog import DecisionRecord


@dataclass(slots=True)
class ReliabilityBin:
    lo: float
    hi: float
    n: int = 0
    avg_predicted: float = 0.0
    avg_realized: float = 0.0


@dataclass(slots=True)
class CalibrationReport:
    """ECE + reliability for one slice (a task_type, or the global pool)."""

    slice_key: str
    n: int
    ece: float
    ece_shrunk: float
    ece_quality: float
    bins: list[ReliabilityBin] = field(default_factory=list)


@dataclass(slots=True)
class CusumFlag:
    cluster: str
    model_id: str
    n: int
    statistic: float
    direction: str  # "over_predicting" | "under_predicting"


def _pairs(rows: list[DecisionRecord]) -> list[tuple[float, float, float]]:
    """(predicted, realized_label, realized_quality) for reconciled rows."""
    out: list[tuple[float, float, float]] = []
    for r in rows:
        if not r.reconciled:
            continue
        predicted = r.predicted_success_chosen
        if predicted is None:
            continue
        label = 1.0 if r.realized_outcome == "success" else 0.0
        quality = r.realized_quality if r.realized_quality is not None else label
        out.append((predicted, label, quality))
    return out


def _ece(pairs: list[tuple[float, float]], n_bins: int) -> tuple[float, list[ReliabilityBin]]:
    bins = [
        ReliabilityBin(lo=i / n_bins, hi=(i + 1) / n_bins)
        for i in range(max(1, n_bins))
    ]
    sums_p = [0.0] * len(bins)
    sums_y = [0.0] * len(bins)
    for p, y in pairs:
        idx = min(len(bins) - 1, int(p * len(bins)))
        bins[idx].n += 1
        sums_p[idx] += p
        sums_y[idx] += y
    total = sum(b.n for b in bins)
    if total == 0:
        return 0.0, bins
    ece = 0.0
    for i, b in enumerate(bins):
        if b.n == 0:
            continue
        b.avg_predicted = sums_p[i] / b.n
        b.avg_realized = sums_y[i] / b.n
        ece += (b.n / total) * abs(b.avg_predicted - b.avg_realized)
    return ece, bins


def calibration_by_task_type(
    rows: list[DecisionRecord],
    *,
    n_bins: int = 10,
    shrinkage_k: float = 20.0,
) -> list[CalibrationReport]:
    """Per-task_type ECE with hierarchical shrinkage toward the global estimate.

    Sparse slices are pulled toward the global ECE with weight ``n / (n + k)`` so a
    task_type with three feedbacks doesn't read as perfectly (mis)calibrated.
    The first report ("global") is the unshrunk pool.
    """
    global_pairs = _pairs(rows)
    g_label = [(p, y) for p, y, _ in global_pairs]
    g_quality = [(p, q) for p, _, q in global_pairs]
    global_ece, global_bins = _ece(g_label, n_bins)
    global_ece_q, _ = _ece(g_quality, n_bins)
    reports = [
        CalibrationReport(
            slice_key="global",
            n=len(global_pairs),
            ece=round(global_ece, 4),
            ece_shrunk=round(global_ece, 4),
            ece_quality=round(global_ece_q, 4),
            bins=global_bins,
        )
    ]

    by_type: dict[str, list[DecisionRecord]] = {}
    for r in rows:
        by_type.setdefault(r.task_type, []).append(r)
    for task_type in sorted(by_type):
        pairs = _pairs(by_type[task_type])
        if not pairs:
            continue
        ece, bins = _ece([(p, y) for p, y, _ in pairs], n_bins)
        ece_q, _ = _ece([(p, q) for p, _, q in pairs], n_bins)
        n = len(pairs)
        shrunk = (n * ece + shrinkage_k * global_ece) / (n + shrinkage_k)
        reports.append(
            CalibrationReport(
                slice_key=task_type,
                n=n,
                ece=round(ece, 4),
                ece_shrunk=round(shrunk, 4),
                ece_quality=round(ece_q, 4),
                bins=bins,
            )
        )
    return reports


def cusum_flags(
    rows: list[DecisionRecord],
    *,
    k: float = 0.25,
    h: float = 2.0,
) -> list[CusumFlag]:
    """Two-sided CUSUM on (predicted - realized) residuals per (cluster, chosen model).

    Flags sustained over-prediction (model got worse than the evidence says — the
    expensive failure mode) and under-prediction, ordered by feedback time. Detection
    only: acting on a flag (evidence reset / down-weight) is a later-phase policy.
    Defaults are sized for binary residuals (|resid| up to 1): the slack absorbs
    routine misses, the threshold requires a sustained run before flagging.
    """
    series: dict[tuple[str, str], list[tuple[float, float]]] = {}
    for r in rows:
        if not r.reconciled:
            continue
        predicted = r.predicted_success_chosen
        if predicted is None or r.realized_model_id is None:
            continue
        label = 1.0 if r.realized_outcome == "success" else 0.0
        series.setdefault((r.cluster, r.realized_model_id), []).append(
            (r.feedback_ts or r.ts, predicted - label)
        )

    flags: list[CusumFlag] = []
    for (cluster, model_id), points in series.items():
        points.sort(key=lambda tr: tr[0])
        s_hi = s_lo = 0.0
        peak_hi = peak_lo = 0.0
        for _, resid in points:
            s_hi = max(0.0, s_hi + resid - k)
            s_lo = max(0.0, s_lo - resid - k)
            peak_hi = max(peak_hi, s_hi)
            peak_lo = max(peak_lo, s_lo)
        if peak_hi > h:
            flags.append(
                CusumFlag(
                    cluster=cluster,
                    model_id=model_id,
                    n=len(points),
                    statistic=round(peak_hi, 4),
                    direction="over_predicting",
                )
            )
        if peak_lo > h:
            flags.append(
                CusumFlag(
                    cluster=cluster,
                    model_id=model_id,
                    n=len(points),
                    statistic=round(peak_lo, 4),
                    direction="under_predicting",
                )
            )
    flags.sort(key=lambda f: f.statistic, reverse=True)
    return flags


def routing_health(rows: list[DecisionRecord]) -> dict[str, float | int]:
    """Decision-stream health rates; the fitness gates for everything analytical.

    feedback_coverage is the share of recommendations that ever got feedback — the
    statistic that decides whether calibration/MNAR machinery is fit for purpose.
    """
    n = len(rows)
    if n == 0:
        return {
            "recommendations": 0,
            "feedback_coverage": 0.0,
            "late_feedback_share": 0.0,
            "escalation_rate": 0.0,
            "exploration_share": 0.0,
            "epsilon_policy_share": 0.0,
            "success_rate": 0.0,
            "top_model_share": 0.0,
            "cheapest_model_share": 0.0,
            "cost_position": 0.0,
        }
    reconciled = sum(1 for r in rows if r.reconciled)
    late = sum(1 for r in rows if r.late_feedback)
    escalated = sum(1 for r in rows if r.escalated)
    successes = sum(1 for r in rows if r.realized_outcome == "success")
    # exploration_share = picks actually changed by the epsilon branch (~epsilon when
    # active); epsilon_policy_share = share of decisions where exploration was possible.
    explored = sum(1 for r in rows if r.explored)
    epsilon_policy = sum(1 for r in rows if r.policy == "epsilon_softmax")
    top_share, cheapest_share, cost_position = _cost_metrics(rows)
    return {
        "recommendations": n,
        "feedback_coverage": round(reconciled / n, 4),
        "late_feedback_share": round(late / reconciled, 4) if reconciled else 0.0,
        "escalation_rate": round(escalated / n, 4),
        "exploration_share": round(explored / n, 4),
        "epsilon_policy_share": round(epsilon_policy / n, 4),
        # success_rate over reconciled rows — pair with cost_position for the Pareto view.
        "success_rate": round(successes / reconciled, 4) if reconciled else 0.0,
        # Routing-optimality signals over the candidate price ladder:
        #  top_model_share      — share picking the MOST expensive candidate (collapse signal,
        #                         arXiv 2602.03478).
        #  cheapest_model_share — share picking the CHEAPEST candidate (aggressive saving).
        #  cost_position        — mean normalized position 0=cheapest .. 1=priciest. The honest
        #                         online "how far up the price ladder do we routinely pick"
        #                         number; pair with success_rate (true regret-vs-oracle needs
        #                         counterfactuals — that lives in the offline RouterBench eval).
        "top_model_share": top_share,
        "cheapest_model_share": cheapest_share,
        "cost_position": cost_position,
    }


def _cost_metrics(rows: list[DecisionRecord]) -> tuple[float, float, float]:
    """(top_model_share, cheapest_model_share, mean cost_position) over rows with candidates."""
    counted = picked_top = picked_cheap = 0
    position_sum = 0.0
    for r in rows:
        if not r.candidates:
            continue
        counted += 1
        costs = [c.est_cost_usd for c in r.candidates]
        lo, hi = min(costs), max(costs)
        chosen = next((c for c in r.candidates if c.model_id == r.chosen_model_id), None)
        if chosen is None:
            continue
        if chosen.est_cost_usd >= hi - 1e-12:
            picked_top += 1
        if chosen.est_cost_usd <= lo + 1e-12:
            picked_cheap += 1
        position_sum += (chosen.est_cost_usd - lo) / (hi - lo) if hi > lo else 0.0
    if not counted:
        return 0.0, 0.0, 0.0
    return (
        round(picked_top / counted, 4),
        round(picked_cheap / counted, 4),
        round(position_sum / counted, 4),
    )


# --------------------------------------------------------------------------- calibration FIT
# The reports above MEASURE calibration; the machinery below FITS a monotonic remap that the
# recommender applies to predicted_success before the tau-clearing decision, so a "0.7" really
# means ~70% realized success. Isotonic regression (pool-adjacent-violators) is non-parametric
# and monotonic; we shrink it toward the identity by n / (n + k) so a sparse slice barely moves
# (the same hierarchical-shrinkage instinct as ``calibration_by_task_type``). Pure stdlib — no
# numpy/sklearn — to stay on the recommend() hot path's dependency budget.


def _isotonic_pav(pairs: list[tuple[float, float]]) -> tuple[list[float], list[float]]:
    """Pool-adjacent-violators isotonic regression of y on x.

    Returns ``(xs, ys)`` where ``xs`` are block right-edges (ascending) and ``ys`` the
    block means (non-decreasing) — a monotonic step function. Empty when no pairs.
    """
    pts = sorted(pairs, key=lambda t: t[0])
    if not pts:
        return [], []

    def _mean(b: list[float]) -> float:
        return b[0] / b[1]

    # Each block: [sum_y, count, right_edge_x].
    blocks: list[list[float]] = []
    for x, y in pts:
        blocks.append([y, 1.0, x])
        while len(blocks) >= 2 and _mean(blocks[-2]) >= _mean(blocks[-1]):
            sy2, c2, x2 = blocks.pop()
            sy1, c1, x1 = blocks.pop()
            blocks.append([sy1 + sy2, c1 + c2, max(x1, x2)])
    xs = [b[2] for b in blocks]
    ys = [clamp01(b[0] / b[1]) for b in blocks]
    return xs, ys


@dataclass(slots=True)
class IsotonicCalibrator:
    """A monotonic predicted->realized remap, shrunk toward the identity at low n."""

    xs: list[float]
    ys: list[float]
    weight: float  # shrinkage toward identity: n / (n + k), in [0, 1]
    n: int

    def transform(self, p: float) -> float:
        if not self.xs:
            return clamp01(p)
        i = bisect.bisect_left(self.xs, p)
        if i >= len(self.ys):
            i = len(self.ys) - 1
        iso = self.ys[i]
        return clamp01(self.weight * iso + (1.0 - self.weight) * p)


@dataclass(slots=True)
class CalibratorSet:
    """Per-task_type calibrators with a global fallback; identity when a slice is unknown."""

    by_task_type: dict[str, IsotonicCalibrator]
    global_map: IsotonicCalibrator | None
    fitted_at: float
    n: int

    def transform(self, task_type: str, p: float) -> float:
        m = self.by_task_type.get(task_type) or self.global_map
        return m.transform(p) if m is not None else clamp01(p)


def _raw_label_pairs(rows: list[DecisionRecord]) -> list[tuple[float, float, str]]:
    """(raw_predicted_chosen, realized_label, task_type) over reconciled rows."""
    out: list[tuple[float, float, str]] = []
    for r in rows:
        if not r.reconciled:
            continue
        raw = r.raw_predicted_success_chosen
        if raw is None:
            continue
        label = 1.0 if r.realized_outcome == "success" else 0.0
        out.append((raw, label, r.task_type))
    return out


def _fit_one(pairs: list[tuple[float, float]], shrinkage_k: float) -> IsotonicCalibrator | None:
    n = len(pairs)
    if n == 0:
        return None
    xs, ys = _isotonic_pav(pairs)
    weight = n / (n + shrinkage_k)
    return IsotonicCalibrator(xs=xs, ys=ys, weight=weight, n=n)


def fit_calibrators(
    rows: list[DecisionRecord],
    *,
    min_n: int,
    shrinkage_k: float,
    now: float,
) -> CalibratorSet | None:
    """Fit a global + per-task_type isotonic calibrator from reconciled decision rows.

    Returns None (=> identity everywhere) when fewer than ``min_n`` reconciled pairs exist.
    Per-task_type maps are only fit for slices that themselves clear ``min_n``; everything
    else falls back to the global map.
    """
    triples = _raw_label_pairs(rows)
    if len(triples) < min_n:
        return None
    global_map = _fit_one([(p, y) for p, y, _ in triples], shrinkage_k)
    grouped: dict[str, list[tuple[float, float]]] = {}
    for p, y, tt in triples:
        grouped.setdefault(tt, []).append((p, y))
    by_type: dict[str, IsotonicCalibrator] = {}
    for tt, ps in grouped.items():
        if len(ps) >= min_n:
            fitted = _fit_one(ps, shrinkage_k)
            if fitted is not None:
                by_type[tt] = fitted
    return CalibratorSet(by_task_type=by_type, global_map=global_map, fitted_at=now, n=len(triples))
