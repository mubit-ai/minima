"""Weak-supervision label coverage: Dawid-Skene label model + surrogate index.

Most turns are unlabeled (no gate, judge sampled at ~15%): the success aggregate learns
from a thin trusted slice while cost/latency telemetry piles up. This module recovers a
fractional ``p_success`` per decision row from several WEAK sources so non-gate rows can
enter aggregation with an honest soft label (``MINIMA_LABEL_MODEL``, default off).

The source set is deliberately small and fixed:

- ``gate`` — the deterministic red->green verdict (``evidence_source == "gate"``). The
  ANCHOR: its accuracy is pinned at 0.98 and never learned, so EM can't drift away from
  the only gold provenance. Gate rows also keep their deterministic label in aggregation
  regardless of the fitted posterior.
- ``judge`` — the LLM judge's quality, length-debiased through the window's
  ``LengthBiasModel`` (identity when unfit) and thresholded at 0.5. Accuracy learned.
- one source per RESERVED implicit signal (``retried`` / ``user_corrected`` /
  ``diff_reverted`` / ``session_continued`` / ``observer_flagged``) from
  ``FeedbackRequest.signals``. Polarity is per-signal (a retry/correction/revert/flag
  votes failure; a continued session votes success); an absent key abstains. Accuracy
  learned from a 0.55 prior. Non-reserved keys are ignored here (free-form on the wire,
  but an unknown signal has no defined polarity).
- ``steps`` — the turn's relayed step outcomes: all-success votes success, any failure
  votes failure, no steps abstains. A weak positive source (steps carry their own gate
  provenance but don't cover the whole turn). Accuracy learned.
- ``surrogate`` (``MINIMA_SURROGATE_INDEX``, default off) — a pure-Python logistic
  regression from realized telemetry (bucketed latency, output tokens, iterations,
  cost) to the trusted label, trained per lane on the trusted-labeled subset (disabled
  below ``SURROGATE_MIN_N`` rows). Its clamped prediction enters the label model as ONE
  MORE SOURCE with learned accuracy — never aggregation directly. It abstains on
  gate-anchored rows (its own training labels) to avoid leakage inflating its accuracy.

EM is standard two-class symmetric-accuracy Dawid-Skene, iterated ``EM_ITERATIONS``
times with learned accuracies clamped to [0.5, 0.99].

Evidence provenance fields NEVER change here: the fitted ``p_success`` affects success
aggregation weight only (``aggregate_by_model(label_model_scores=...)``).
"""

from __future__ import annotations

import math
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass, field
from threading import Lock

from minima.memory.records import (
    EVIDENCE_GATE,
    EVIDENCE_JUDGE,
    TRUSTED_LABEL_SOURCES,
    clamp01,
)
from minima.metrics.judge_calibration import (
    LengthBiasModel,
    corrected_quality,
    fit_length_bias,
)
from minima.recommender.decisionlog import DecisionRecord

SOURCE_GATE = "gate"
SOURCE_JUDGE = "judge"
SOURCE_STEPS = "steps"
SOURCE_SURROGATE = "surrogate"

RESERVED_SIGNALS = (
    "retried",
    "user_corrected",
    "diff_reverted",
    "session_continued",
    "observer_flagged",
)
# True = the signal firing is evidence of SUCCESS; False = evidence of failure.
_SIGNAL_POLARITY: dict[str, bool] = {
    "retried": False,
    "user_corrected": False,
    "diff_reverted": False,
    "session_continued": True,
    "observer_flagged": False,
}

ANCHOR_ACCURACY = 0.98
SIGNAL_PRIOR_ACCURACY = 0.55
_INITIAL_ACCURACY = {
    SOURCE_JUDGE: 0.75,
    SOURCE_STEPS: 0.6,
    SOURCE_SURROGATE: 0.6,
}
_ACC_MIN, _ACC_MAX = 0.5, 0.99
_PRIOR_MIN, _PRIOR_MAX = 0.05, 0.95
EM_ITERATIONS = 10

SURROGATE_MIN_N = 50
SURROGATE_CLAMP = (0.1, 0.9)
_SURROGATE_STEPS = 300
_SURROGATE_LR = 0.5

SIGNAL_CACHE_CAPACITY = 4096


@dataclass(slots=True)
class FeedbackSignals:
    """Per-rec_id feedback facts the decision log deliberately does not carry."""

    signals: dict[str, bool] = field(default_factory=dict)
    steps_all_success: bool | None = None
    iterations: int | None = None


class SignalCache:
    """Bounded in-process LRU of rec_id -> FeedbackSignals, written by the feedback
    router and read by the lazy per-lane label-model fit. Same durability tier as the
    exploration counters: process-local, reset on restart — the label model degrades
    gracefully to its other sources."""

    def __init__(self, capacity: int = SIGNAL_CACHE_CAPACITY):
        self._capacity = capacity
        self._items: OrderedDict[str, FeedbackSignals] = OrderedDict()
        self._lock = Lock()

    def put(self, rec_id: str, fs: FeedbackSignals) -> None:
        with self._lock:
            self._items[rec_id] = fs
            self._items.move_to_end(rec_id)
            while len(self._items) > self._capacity:
                self._items.popitem(last=False)

    def get(self, rec_id: str) -> FeedbackSignals | None:
        with self._lock:
            return self._items.get(rec_id)

    def snapshot(self) -> dict[str, FeedbackSignals]:
        with self._lock:
            return dict(self._items)


@dataclass(slots=True)
class SourceVotes:
    rec_id: str
    votes: dict[str, int]


@dataclass(slots=True)
class LabelModelFit:
    p_success: dict[str, float]
    accuracies: dict[str, float]
    prior: float
    n_rows: int


def build_votes(
    rows: list[DecisionRecord],
    *,
    signals_by_rec: Mapping[str, FeedbackSignals] | None = None,
    length_bias: LengthBiasModel | None = None,
    surrogate: SurrogateModel | None = None,
) -> list[SourceVotes]:
    """Map each reconciled decision row to its per-source binary votes (abstain = absent)."""
    out: list[SourceVotes] = []
    for r in rows:
        if not r.reconciled:
            continue
        votes: dict[str, int] = {}
        success = 1 if r.realized_outcome == "success" else 0
        if r.evidence_source == EVIDENCE_GATE:
            votes[SOURCE_GATE] = success
        elif r.evidence_source == EVIDENCE_JUDGE and r.realized_quality is not None:
            q = r.realized_quality
            if length_bias is not None:
                q = corrected_quality(length_bias, q, r.realized_output_tokens)
            votes[SOURCE_JUDGE] = 1 if q >= 0.5 else 0
        fs = (signals_by_rec or {}).get(r.recommendation_id)
        if fs is not None:
            for key in RESERVED_SIGNALS:
                if key not in fs.signals:
                    continue
                fired = fs.signals[key]
                positive = _SIGNAL_POLARITY[key]
                votes[key] = 1 if fired == positive else 0
            if fs.steps_all_success is not None:
                votes[SOURCE_STEPS] = 1 if fs.steps_all_success else 0
        if surrogate is not None and SOURCE_GATE not in votes:
            p = surrogate_predict(surrogate, r, fs.iterations if fs else None)
            if p is not None:
                votes[SOURCE_SURROGATE] = 1 if p >= 0.5 else 0
        if votes:
            out.append(SourceVotes(rec_id=r.recommendation_id, votes=votes))
    return out


def _initial_accuracy(source: str) -> float:
    if source == SOURCE_GATE:
        return ANCHOR_ACCURACY
    if source in RESERVED_SIGNALS:
        return SIGNAL_PRIOR_ACCURACY
    return _INITIAL_ACCURACY.get(source, SIGNAL_PRIOR_ACCURACY)


def fit_label_model(rows: list[SourceVotes], *, iters: int = EM_ITERATIONS) -> LabelModelFit:
    """Two-class symmetric Dawid-Skene EM. The gate source's accuracy is pinned."""
    if not rows:
        return LabelModelFit(p_success={}, accuracies={}, prior=0.5, n_rows=0)
    sources = sorted({s for r in rows for s in r.votes})
    acc = {s: _initial_accuracy(s) for s in sources}
    prior = 0.5
    posteriors: dict[str, float] = {}
    for _ in range(iters):
        for r in rows:
            l1 = prior
            l0 = 1.0 - prior
            for s, v in r.votes.items():
                a = acc[s]
                l1 *= a if v == 1 else 1.0 - a
                l0 *= 1.0 - a if v == 1 else a
            total = l1 + l0
            posteriors[r.rec_id] = l1 / total if total > 0 else 0.5
        prior = min(
            _PRIOR_MAX,
            max(_PRIOR_MIN, sum(posteriors.values()) / len(posteriors)),
        )
        for s in sources:
            if s == SOURCE_GATE:
                continue
            agree = 0.0
            n = 0
            for r in rows:
                if s not in r.votes:
                    continue
                v = r.votes[s]
                p = posteriors[r.rec_id]
                agree += p if v == 1 else 1.0 - p
                n += 1
            if n:
                acc[s] = min(_ACC_MAX, max(_ACC_MIN, agree / n))
    return LabelModelFit(
        p_success={k: clamp01(v) for k, v in posteriors.items()},
        accuracies=acc,
        prior=prior,
        n_rows=len(rows),
    )


# --------------------------------------------------------------- surrogate index (D3)


@dataclass(slots=True)
class SurrogateModel:
    weights: list[float]
    bias: float
    means: list[float]
    stds: list[float]
    n: int


def _surrogate_features(r: DecisionRecord, iterations: int | None) -> list[float] | None:
    if not r.reconciled:
        return None
    if (
        r.realized_latency_ms is None
        and r.realized_output_tokens is None
        and r.realized_cost_usd is None
    ):
        return None
    latency_bucket = (
        float(min(6, int(math.log10(max(1.0, float(r.realized_latency_ms))))))
        if r.realized_latency_ms is not None
        else 0.0
    )
    return [
        latency_bucket,
        math.log1p(float(r.realized_output_tokens or 0)),
        float(iterations or 0),
        math.log1p(float(r.realized_cost_usd or 0.0) * 1000.0),
    ]


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def fit_surrogate(
    rows: list[DecisionRecord],
    *,
    signals_by_rec: Mapping[str, FeedbackSignals] | None = None,
    min_n: int = SURROGATE_MIN_N,
) -> SurrogateModel | None:
    """Gradient-descent logistic regression on the lane's trusted-labeled subset.

    Returns None (disabled) below ``min_n`` trusted rows. The prediction is a label-model
    SOURCE only — it never touches provenance or aggregation directly.
    """
    xs: list[list[float]] = []
    ys: list[float] = []
    for r in rows:
        if r.evidence_source not in TRUSTED_LABEL_SOURCES:
            continue
        fs = (signals_by_rec or {}).get(r.recommendation_id)
        feats = _surrogate_features(r, fs.iterations if fs else None)
        if feats is None:
            continue
        xs.append(feats)
        ys.append(1.0 if r.realized_outcome == "success" else 0.0)
    n = len(xs)
    if n < min_n:
        return None
    dim = len(xs[0])
    means = [sum(x[j] for x in xs) / n for j in range(dim)]
    stds = []
    for j in range(dim):
        var = sum((x[j] - means[j]) ** 2 for x in xs) / n
        stds.append(math.sqrt(var) if var > 0 else 1.0)
    zs = [[(x[j] - means[j]) / stds[j] for j in range(dim)] for x in xs]
    w = [0.0] * dim
    b = 0.0
    for _ in range(_SURROGATE_STEPS):
        gw = [0.0] * dim
        gb = 0.0
        for x, y in zip(zs, ys, strict=True):
            err = _sigmoid(b + sum(wj * xj for wj, xj in zip(w, x, strict=True))) - y
            for j in range(dim):
                gw[j] += err * x[j]
            gb += err
        for j in range(dim):
            w[j] -= _SURROGATE_LR * gw[j] / n
        b -= _SURROGATE_LR * gb / n
    return SurrogateModel(weights=w, bias=b, means=means, stds=stds, n=n)


def surrogate_predict(
    model: SurrogateModel, r: DecisionRecord, iterations: int | None
) -> float | None:
    feats = _surrogate_features(r, iterations)
    if feats is None:
        return None
    z = model.bias + sum(
        wj * (xj - mj) / sj
        for wj, xj, mj, sj in zip(model.weights, feats, model.means, model.stds, strict=True)
    )
    lo, hi = SURROGATE_CLAMP
    return min(hi, max(lo, _sigmoid(z)))


def fit_lane_label_scores(
    rows: list[DecisionRecord],
    *,
    signals_by_rec: Mapping[str, FeedbackSignals] | None = None,
    surrogate_enabled: bool = False,
) -> dict[str, float]:
    """One lane window -> rec_id -> p_success. The engine caches this per lane on the
    calibrator refresh cadence and threads it into ``aggregate_by_model``."""
    length_bias = fit_length_bias(rows)
    surrogate = (
        fit_surrogate(rows, signals_by_rec=signals_by_rec) if surrogate_enabled else None
    )
    votes = build_votes(
        rows,
        signals_by_rec=signals_by_rec,
        length_bias=length_bias,
        surrogate=surrogate,
    )
    return fit_label_model(votes).p_success
