"""F2 probe cold start: deterministic vectors, neighbor init, prior borrowing."""

from __future__ import annotations

import math

import pytest

from minima.catalog.probe import cold_start_prior, init_from_neighbors, probe_vector
from minima.recommender import score
from minima.schemas.common import TaskType
from minima.schemas.models_catalog import ModelCard


def _card(model_id: str, caps: dict[TaskType, float] | None = None, **over) -> ModelCard:
    base: dict = {
        "model_id": model_id,
        "provider": "test",
        "input_cost_per_mtok": 1.0,
        "output_cost_per_mtok": 5.0,
        "context_window": 200_000,
        "capability_by_task_type": caps or {},
    }
    base.update(over)
    return ModelCard(**base)


CHEAP_CODER = _card("cheap-coder", {TaskType.code: 0.7, TaskType.qa: 0.8})
CHEAP_TWIN = _card("cheap-twin", {TaskType.code: 0.72, TaskType.qa: 0.78})
PREMIUM = _card(
    "premium",
    {TaskType.code: 0.95, TaskType.qa: 0.93},
    input_cost_per_mtok=15.0,
    output_cost_per_mtok=75.0,
)
NEWCOMER = _card("newcomer", None)  # no per-task entries at all


class TestProbeVector:
    def test_unit_length_and_deterministic(self):
        v = probe_vector(CHEAP_CODER)
        assert v == probe_vector(CHEAP_CODER)
        assert math.sqrt(sum(x * x for x in v)) == pytest.approx(1.0)

    def test_missing_entries_fall_back_to_intelligence_index(self):
        with_ii = _card("m", None, capability_priors={"intelligence_index": 0.9})
        without = _card("m", None)
        assert probe_vector(with_ii) != probe_vector(without)


class TestNeighbors:
    def test_excludes_self_and_capless_models(self):
        catalog = [CHEAP_CODER, CHEAP_TWIN, PREMIUM, NEWCOMER]
        neighbors = init_from_neighbors(NEWCOMER, catalog, k=3)
        ids = [m for m, _ in neighbors]
        assert "newcomer" not in ids
        assert set(ids) <= {"cheap-coder", "cheap-twin", "premium"}

    def test_price_shape_prefers_the_cheap_twin(self):
        # The newcomer is priced like the cheap models, so cosine over the
        # (capability, price, context) vector ranks a cheap model first.
        neighbors = init_from_neighbors(NEWCOMER, [CHEAP_CODER, CHEAP_TWIN, PREMIUM], k=1)
        assert neighbors[0][0] in {"cheap-coder", "cheap-twin"}

    def test_k_bounds_result(self):
        neighbors = init_from_neighbors(NEWCOMER, [CHEAP_CODER, CHEAP_TWIN, PREMIUM], k=2)
        assert len(neighbors) == 2


class TestColdStartPrior:
    def test_weighted_mean_of_neighbor_priors(self):
        prior = cold_start_prior(NEWCOMER, TaskType.code, [CHEAP_CODER, CHEAP_TWIN, PREMIUM])
        assert prior is not None
        assert 0.7 <= prior <= 0.95

    def test_none_when_no_neighbor_covers_the_task(self):
        catalog = [_card("only", {TaskType.qa: 0.8})]
        assert cold_start_prior(NEWCOMER, TaskType.creative, catalog) is None

    def test_none_when_catalog_is_empty(self):
        assert cold_start_prior(NEWCOMER, TaskType.code, []) is None

    def test_flag_off_default_prior_path_is_untouched(self):
        # score.capability_prior stays the sole default-path source of priors.
        assert score.capability_prior(NEWCOMER, TaskType.code) == 0.5
