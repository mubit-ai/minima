"""Judge length-debias and PPI-rectified success rates over the decision log.

Two corrections for the LLM judge's known failure modes, both anchored on gate-verified
outcomes (deterministic red->green checks — the only gold provenance):

1. **Length debias** (``fit_length_bias`` / ``corrected_quality``). LLM judges reward
   verbosity; the harness's judge scores terse-but-correct answers low (observed live).
   The fit regresses judge quality *residuals* on realized output tokens and
   ``corrected_quality`` removes the length-dependent component beyond the mean length.

2. **PPI rectifier** (``ppi_success_rate``). Prediction-powered inference: treat judge
   labels as predictions and gate labels as gold, estimate success as
   ``judge_mean + (gate_mean - judge_mean on shared strata)``.

Data approximation (honest about what THIS log contains): a decision row carries exactly
one ``evidence_source``, so no row has both a judge score and a gate verdict — the ideal
per-item (judge, gold) overlap does not exist. Both corrections therefore anchor at the
**cluster** level instead:

- The length fit's residual for a judge row is ``quality - gate_success_rate(cluster)``,
  using only judge rows whose cluster also has gate-labeled rows in the window. The gate
  rate is a cluster-level proxy for the row's unknown gold score; the slope is unbiased
  for the length effect to the extent length is independent of within-cluster gold
  variation.
- The PPI rectifier is a difference of *means per shared cluster* (gate-count weighted),
  not a per-item difference; the interval width uses a pooled normal approximation that
  ignores between-stratum covariance.

``fit_calibrators`` (isotonic, in ``metrics.calibration``) fits on binary outcome labels,
which this module never re-derives from corrected quality — flipping outcome labels from
a fitted correction would fabricate evidence. Corrections apply only where a real judge
quality exists; ``None`` stays ``None``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from minima.memory.records import EVIDENCE_GATE, EVIDENCE_JUDGE, clamp01
from minima.recommender.decisionlog import DecisionRecord

MIN_FIT_N = 8

_Z_95 = 1.959964


@dataclass(slots=True)
class LengthBiasModel:
    slope: float
    intercept: float
    mean_output_tokens: float
    n: int


@dataclass(slots=True)
class JudgeBiasStats:
    length_coefficient: float
    n_fit: int
    mean_output_tokens: float
    corrected: bool


@dataclass(slots=True)
class PpiEstimate:
    value: float
    raw_judge_value: float
    gate_n: int
    judge_n: int
    interval_width: float


def _gate_cluster_rates(rows: list[DecisionRecord]) -> dict[str, float]:
    counts: dict[str, tuple[int, int]] = {}
    for r in rows:
        if not r.reconciled or r.evidence_source != EVIDENCE_GATE:
            continue
        succ, n = counts.get(r.cluster, (0, 0))
        counts[r.cluster] = (succ + (1 if r.realized_outcome == "success" else 0), n + 1)
    return {c: succ / n for c, (succ, n) in counts.items() if n > 0}


def fit_length_bias(
    rows: list[DecisionRecord], *, min_n: int = MIN_FIT_N
) -> LengthBiasModel | None:
    """Closed-form least squares of judge-quality residuals on output tokens.

    Residual = judge quality - gate success rate of the SAME cluster (the available
    gold anchor; see module docstring). None when fewer than ``min_n`` anchored judge
    rows exist or output length carries no variance.
    """
    gate_rates = _gate_cluster_rates(rows)
    pts: list[tuple[float, float]] = []
    for r in rows:
        if not r.reconciled or r.evidence_source != EVIDENCE_JUDGE:
            continue
        if r.realized_quality is None or r.realized_output_tokens is None:
            continue
        rate = gate_rates.get(r.cluster)
        if rate is None:
            continue
        pts.append((float(r.realized_output_tokens), r.realized_quality - rate))
    n = len(pts)
    if n < min_n:
        return None
    mean_x = sum(x for x, _ in pts) / n
    mean_y = sum(y for _, y in pts) / n
    sxx = sum((x - mean_x) ** 2 for x, _ in pts)
    if sxx <= 0.0:
        return None
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in pts)
    slope = sxy / sxx
    return LengthBiasModel(
        slope=slope,
        intercept=mean_y - slope * mean_x,
        mean_output_tokens=mean_x,
        n=n,
    )


def corrected_quality(
    model: LengthBiasModel, quality: float, output_tokens: int | None
) -> float:
    """Remove the fitted length effect beyond the mean length; clamped to [0, 1].

    Only the length-DEPENDENT component is subtracted — the intercept (cluster-level
    judge/gate disagreement) is outcome miscalibration, owned by the isotonic remap.
    """
    if output_tokens is None:
        return clamp01(quality)
    return clamp01(quality - model.slope * (float(output_tokens) - model.mean_output_tokens))


def judge_bias_stats(rows: list[DecisionRecord], *, min_n: int = MIN_FIT_N) -> JudgeBiasStats:
    model = fit_length_bias(rows, min_n=min_n)
    if model is None:
        return JudgeBiasStats(
            length_coefficient=0.0, n_fit=0, mean_output_tokens=0.0, corrected=False
        )
    return JudgeBiasStats(
        length_coefficient=round(model.slope, 8),
        n_fit=model.n,
        mean_output_tokens=round(model.mean_output_tokens, 2),
        corrected=True,
    )


def _labels_by_cluster(
    rows: list[DecisionRecord], source: str
) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for r in rows:
        if not r.reconciled or r.evidence_source != source:
            continue
        out.setdefault(r.cluster, []).append(1.0 if r.realized_outcome == "success" else 0.0)
    return out


def ppi_success_rate(
    gate_rows: list[DecisionRecord], judge_rows: list[DecisionRecord]
) -> PpiEstimate | None:
    """Difference-of-means PPI: judge estimate + gate-count-weighted per-cluster rectifier.

    ``gate_n`` counts only gate rows in clusters that ALSO have judge rows — the rows
    the rectifier actually uses. No shared cluster => rectifier 0 and
    ``value == raw_judge_value`` (the uncorrected estimate, honestly labeled by the
    identical values). None when there are no judge labels at all.
    """
    judge_by_cluster = _labels_by_cluster(judge_rows, EVIDENCE_JUDGE)
    gate_by_cluster = _labels_by_cluster(gate_rows, EVIDENCE_GATE)
    judge_labels = [y for ys in judge_by_cluster.values() for y in ys]
    if not judge_labels:
        return None
    judge_n = len(judge_labels)
    judge_mean = sum(judge_labels) / judge_n

    rect_num = 0.0
    gate_n = 0
    gate_succ = 0.0
    overlap_judge: list[float] = []
    for cluster, g in gate_by_cluster.items():
        j = judge_by_cluster.get(cluster)
        if not j:
            continue
        rect_num += len(g) * (sum(g) / len(g) - sum(j) / len(j))
        gate_n += len(g)
        gate_succ += sum(g)
        overlap_judge.extend(j)
    rectifier = rect_num / gate_n if gate_n else 0.0
    value = clamp01(judge_mean + rectifier)

    var = judge_mean * (1.0 - judge_mean) / judge_n
    if gate_n:
        pg = gate_succ / gate_n
        pj = sum(overlap_judge) / len(overlap_judge)
        var += pg * (1.0 - pg) / gate_n + pj * (1.0 - pj) / len(overlap_judge)
    return PpiEstimate(
        value=round(value, 4),
        raw_judge_value=round(judge_mean, 4),
        gate_n=gate_n,
        judge_n=judge_n,
        interval_width=round(2.0 * _Z_95 * math.sqrt(var), 4),
    )


def _split_by_source(
    rows: list[DecisionRecord],
) -> tuple[list[DecisionRecord], list[DecisionRecord]]:
    gate = [r for r in rows if r.reconciled and r.evidence_source == EVIDENCE_GATE]
    judge = [r for r in rows if r.reconciled and r.evidence_source == EVIDENCE_JUDGE]
    return gate, judge


def ppi_overall(rows: list[DecisionRecord]) -> PpiEstimate | None:
    gate, judge = _split_by_source(rows)
    return ppi_success_rate(gate, judge)


def ppi_by_model(rows: list[DecisionRecord]) -> dict[str, PpiEstimate]:
    by_model: dict[str, list[DecisionRecord]] = {}
    for r in rows:
        if not r.reconciled:
            continue
        by_model.setdefault(r.realized_model_id or r.chosen_model_id, []).append(r)
    out: dict[str, PpiEstimate] = {}
    for model_id in sorted(by_model):
        est = ppi_overall(by_model[model_id])
        if est is not None:
            out[model_id] = est
    return out
