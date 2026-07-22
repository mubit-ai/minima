"""Neural-linear contextual scoring (F1, ``MINIMA_CONTEXTUAL_BANDIT``, default off).

Context-vector reality check: Mubit recall returns evidence records (score /
knowledge_confidence / metadata) — the embedding vectors stay server-side and are NOT
accessible at recommend time. The context vector is therefore built from what IS
deterministic at request time: the classifier's task_type (one-hot), difficulty
(ordinal), expected token counts (log-scaled), the extracted feature vector, and tag
presence. No LLM, no network, no randomness.

Per (lane, model) Bayesian linear regression head: pure-Python ridge posterior
maintained via Sherman-Morrison rank-1 updates (A_inv, b). For a fixed context x the
head's predictive success is exactly Gaussian — mean x·w_hat, variance x^T A_inv x —
so sampling the scalar predictive marginal per Monte-Carlo round is distributionally
identical to sampling the weight posterior and projecting.

Selection blends the head with the existing Beta cell by evidence mass
``w = n_cell / (n_cell + BLEND_K)`` and Monte-Carlos the blended pick exactly like
``score.thompson_select`` — the selection frequencies ARE the logged propensities, so
off-policy evaluation stays valid when the flag is on. Head updates use trusted-label
feedback only; state is in-memory and TenantContext-scoped.
"""

from __future__ import annotations

import math
import random
from threading import Lock

from minima.schemas.common import Difficulty, TaskType

# Evidence mass at which the Beta cell and the linear head contribute equally.
BLEND_K = 10.0
# Ridge regularizer (prior precision) for a fresh head.
RIDGE_LAMBDA = 1.0
# Bound on remembered pending contexts (rec_id -> vector) awaiting feedback.
PENDING_CAP = 4096

_TASK_TYPES = tuple(TaskType)
_DIFF_ORDINAL = {d: i / (len(Difficulty) - 1) for i, d in enumerate(Difficulty)}
CONTEXT_DIM = 1 + len(_TASK_TYPES) + 1 + 2 + 7 + 1


def _log_scale(tokens: int, cap: float = 6.0) -> float:
    return min(1.0, math.log10(max(1, tokens)) / cap)


def context_vector(
    task_type: TaskType,
    difficulty: Difficulty,
    input_tokens: int,
    output_tokens: int,
    features: dict[str, float],
    has_tags: bool,
) -> list[float]:
    x = [1.0]
    x.extend(1.0 if t == task_type else 0.0 for t in _TASK_TYPES)
    x.append(_DIFF_ORDINAL.get(difficulty, 0.5))
    x.append(_log_scale(input_tokens))
    x.append(_log_scale(output_tokens))
    for name in (
        "reasoning",
        "code",
        "structured_output",
        "creativity",
        "expected_input_output_length",
        "language",
        "tool_use",
    ):
        x.append(max(0.0, min(1.0, float(features.get(name, 0.0)))))
    x.append(1.0 if has_tags else 0.0)
    return x


class _Head:
    """Ridge posterior over one (lane, model): A_inv and b, Sherman-Morrison updates."""

    __slots__ = ("a_inv", "b", "n")

    def __init__(self, dim: int):
        self.a_inv = [
            [(1.0 / RIDGE_LAMBDA if i == j else 0.0) for j in range(dim)] for i in range(dim)
        ]
        self.b = [0.0] * dim
        self.n = 0

    def update(self, x: list[float], y: float) -> None:
        ax = [sum(row[j] * x[j] for j in range(len(x))) for row in self.a_inv]
        denom = 1.0 + sum(x[i] * ax[i] for i in range(len(x)))
        for i in range(len(x)):
            for j in range(len(x)):
                self.a_inv[i][j] -= ax[i] * ax[j] / denom
        for i in range(len(x)):
            self.b[i] += y * x[i]
        self.n += 1

    def predict(self, x: list[float]) -> tuple[float, float]:
        """Predictive ``(mean, std)`` of success for context x (clamped mean)."""
        ax = [sum(row[j] * x[j] for j in range(len(x))) for row in self.a_inv]
        w = [sum(self.a_inv[i][j] * self.b[j] for j in range(len(x))) for i in range(len(x))]
        mean = sum(w[i] * x[i] for i in range(len(x)))
        var = max(1e-9, sum(x[i] * ax[i] for i in range(len(x))))
        return max(0.0, min(1.0, mean)), math.sqrt(var)


class ContextualStore:
    """In-memory per-tenant state: (lane, model) heads + pending rec_id contexts."""

    def __init__(self, dim: int = CONTEXT_DIM):
        self._dim = dim
        self._heads: dict[tuple[str, str], _Head] = {}
        self._pending: dict[str, tuple[str, list[float]]] = {}
        self._lock = Lock()

    def note_context(self, rec_id: str, lane: str, x: list[float]) -> None:
        with self._lock:
            self._pending[rec_id] = (lane, list(x))
            while len(self._pending) > PENDING_CAP:
                self._pending.pop(next(iter(self._pending)))

    def update(self, rec_id: str, model_id: str, y: float) -> bool:
        """Fold a trusted-label outcome into the chosen model's head. Pop-once: a
        replayed rec_id is a no-op, so duplicate feedback never double-counts."""
        with self._lock:
            pending = self._pending.pop(rec_id, None)
            if pending is None:
                return False
            lane, x = pending
            head = self._heads.get((lane, model_id))
            if head is None:
                head = _Head(self._dim)
                self._heads[(lane, model_id)] = head
            head.update(x, max(0.0, min(1.0, y)))
            return True

    def head_stats(self, lane: str, model_id: str, x: list[float]) -> tuple[float, float, int]:
        """Predictive ``(mean, std, n)``; a fresh head is a flat 0.5 with wide std."""
        with self._lock:
            head = self._heads.get((lane, model_id))
            if head is None or head.n == 0:
                return 0.5, 1.0, 0
            mean, std = head.predict(x)
            return mean, std, head.n


def blend_weight(n_cell: float) -> float:
    return max(0.0, n_cell) / (max(0.0, n_cell) + BLEND_K)


def contextual_thompson_select(
    items: list[tuple[str, float, float, float, float, float, float]],
    tau: float,
    rng: random.Random,
    samples: int = 128,
) -> tuple[str, dict[str, float]]:
    """Blended posterior-sampling selection over the cost-aware objective.

    ``items`` is ``(model_id, alpha, beta, est_cost_usd, head_mean, head_std, w_cell)``
    per candidate. Each round samples theta_beta ~ Beta and theta_head ~ N(mean, std)
    (clamped to [0, 1]), blends ``w_cell * theta_beta + (1 - w_cell) * theta_head``, and
    picks the cheapest candidate whose blended draw clears tau (falling back to the
    highest draw). Selection frequencies ARE the propensities and the returned pick is
    sampled from them — identical honesty contract to ``score.thompson_select``.
    """
    if not items:
        return "", {}
    counts = dict.fromkeys((m for m, *_ in items), 0)
    for _ in range(max(1, samples)):
        theta: dict[str, float] = {}
        for model_id, alpha, beta, _cost, head_mean, head_std, w_cell in items:
            t_beta = rng.betavariate(alpha, beta)
            t_head = max(0.0, min(1.0, rng.gauss(head_mean, head_std)))
            theta[model_id] = w_cell * t_beta + (1.0 - w_cell) * t_head
        clears = [(m, cost) for m, _a, _b, cost, *_rest in items if theta[m] >= tau]
        if clears:
            pick = min(clears, key=lambda mc: (mc[1], -theta[mc[0]]))[0]
        else:
            pick = max(theta, key=theta.__getitem__)
        counts[pick] += 1
    total = sum(counts.values()) or 1
    propensities = {m: counts[m] / total for m in counts}
    pick_id = rng.choices(list(counts), weights=[counts[m] for m in counts], k=1)[0]
    return pick_id, propensities
