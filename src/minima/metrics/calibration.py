"""Calibration and routing-health metrics over the decision log.

Pure functions over reconciled ``DecisionRecord`` rows — no state of their own, so the
same code powers the tenant-scoped ``GET /v1/calibration`` endpoint and the ops-side
``minima-calibration-report`` console script.

A recommendation is "reconciled" once feedback arrived; only reconciled rows carry a
realized label. Calibration compares the chosen candidate's predicted_success at
decision time against that label (success=1 primary; quality-weighted alongside).
"""

from __future__ import annotations

from dataclasses import dataclass, field

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
        }
    reconciled = sum(1 for r in rows if r.reconciled)
    late = sum(1 for r in rows if r.late_feedback)
    escalated = sum(1 for r in rows if r.escalated)
    # exploration_share = picks actually changed by the epsilon branch (~epsilon when
    # active); epsilon_policy_share = share of decisions where exploration was possible.
    explored = sum(1 for r in rows if r.explored)
    epsilon_policy = sum(1 for r in rows if r.policy == "epsilon_softmax")
    return {
        "recommendations": n,
        "feedback_coverage": round(reconciled / n, 4),
        "late_feedback_share": round(late / reconciled, 4) if reconciled else 0.0,
        "escalation_rate": round(escalated / n, 4),
        "exploration_share": round(explored / n, 4),
        "epsilon_policy_share": round(epsilon_policy / n, 4),
    }
