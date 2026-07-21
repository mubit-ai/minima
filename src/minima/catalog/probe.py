"""Probe cold start (F2, ``MINIMA_PROBE_COLD_START``, default off).

Deterministic probe VECTORS only: each model's vector is derived from its catalog card
(per-task capability entries + price + context window) — this PR makes NO live LLM
probe calls. The :class:`ProbeRunner` protocol documents the seam where a future live
probe (run a fixed micro-suite against a new model, score it, feed the vector) would
plug in; today the deterministic vector is the sole implementation surface.

A model that lacks its own ``capability_by_task_type`` entry for the requested task
borrows a prior from its cosine-nearest catalog neighbors: the similarity-weighted
mean of their capability priors for that task type.
"""

from __future__ import annotations

import math
from typing import Protocol, runtime_checkable

from minima.memory.records import clamp01
from minima.schemas.common import TaskType
from minima.schemas.models_catalog import ModelCard

_TASK_TYPES = tuple(TaskType)
_DEFAULT_CAP = 0.5


@runtime_checkable
class ProbeRunner(Protocol):
    """Future seam: run a live probe suite against a model and return its vector.

    Not implemented in this PR — deterministic catalog-derived vectors stand in.
    """

    def probe(self, card: ModelCard) -> list[float]: ...


def _price_feature(cost_per_mtok: float) -> float:
    return clamp01((math.log10(max(1e-3, cost_per_mtok)) + 2.0) / 4.0)


def _context_feature(context_window: int) -> float:
    return clamp01(math.log10(max(1, context_window)) / 7.0)


def probe_vector(card: ModelCard) -> list[float]:
    """Normalized (unit-length) deterministic feature vector for one model."""
    intel = card.capability_priors.get("intelligence_index")
    fallback = clamp01(intel) if intel is not None else _DEFAULT_CAP
    v = [clamp01(card.capability_by_task_type.get(t, fallback)) for t in _TASK_TYPES]
    v.append(_price_feature(card.input_cost_per_mtok))
    v.append(_price_feature(card.output_cost_per_mtok))
    v.append(_context_feature(card.context_window))
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v] if norm > 0 else v


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def init_from_neighbors(
    new_model: ModelCard, catalog: list[ModelCard], k: int = 3
) -> list[tuple[str, float]]:
    """Cosine-nearest existing models (id, similarity), best first, self excluded.

    Only models that carry their own per-task capability entries qualify as
    neighbors — a fellow cold-start model has nothing to lend.
    """
    target = probe_vector(new_model)
    scored = [
        (card.model_id, _cosine(target, probe_vector(card)))
        for card in catalog
        if card.model_id != new_model.model_id and card.capability_by_task_type
    ]
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored[:k]


def cold_start_prior(
    model: ModelCard, task_type: TaskType, catalog: list[ModelCard], k: int = 3
) -> float | None:
    """Similarity-weighted mean of the k nearest neighbors' priors for ``task_type``.

    None when no neighbor carries an entry for this task type (caller keeps its
    existing fallback prior).
    """
    by_id = {card.model_id: card for card in catalog}
    total = 0.0
    mass = 0.0
    for model_id, sim in init_from_neighbors(model, catalog, k=k):
        weight = max(0.0, sim)
        neighbor = by_id.get(model_id)
        if weight <= 0.0 or neighbor is None:
            continue
        cap = neighbor.capability_by_task_type.get(task_type)
        if cap is None:
            continue
        total += weight * clamp01(cap)
        mass += weight
    if mass <= 0.0:
        return None
    return clamp01(total / mass)
