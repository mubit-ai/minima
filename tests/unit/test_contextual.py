"""F1 neural-linear contextual scoring: head math, store discipline, blended selection."""

from __future__ import annotations

import random

import pytest

from minima.recommender.contextual import (
    CONTEXT_DIM,
    ContextualStore,
    blend_weight,
    context_vector,
    contextual_thompson_select,
)
from minima.schemas.common import Difficulty, TaskType


def _x(task_type: TaskType = TaskType.code, difficulty: Difficulty = Difficulty.hard):
    return context_vector(
        task_type, difficulty, 1500, 500, {"code": 1.0, "reasoning": 0.4}, True
    )


class TestContextVector:
    def test_deterministic_and_fixed_dim(self):
        a = _x()
        b = _x()
        assert a == b
        assert len(a) == CONTEXT_DIM

    def test_one_hot_and_ordinal_vary(self):
        code = _x(TaskType.code, Difficulty.trivial)
        qa = _x(TaskType.qa, Difficulty.expert)
        assert code != qa
        assert code[0] == 1.0  # bias
        types = list(TaskType)
        assert code[1 + types.index(TaskType.code)] == 1.0
        assert qa[1 + types.index(TaskType.code)] == 0.0
        assert qa[1 + types.index(TaskType.qa)] == 1.0

    def test_bounded_features(self):
        x = context_vector(
            TaskType.other, Difficulty.medium, 10**9, 10**9, {"code": 99.0}, False
        )
        assert all(0.0 <= v <= 1.0 for v in x)


class TestHead:
    def test_updates_pull_mean_toward_labels_and_shrink_uncertainty(self):
        store = ContextualStore()
        x = _x()
        mean0, std0, n0 = store.head_stats("lane", "m1", x)
        assert (mean0, n0) == (0.5, 0)
        for i in range(12):
            store.note_context(f"r{i}", "lane", x)
            assert store.update(f"r{i}", "m1", 1.0)
        mean1, std1, n1 = store.head_stats("lane", "m1", x)
        assert n1 == 12
        assert mean1 > 0.8
        assert std1 < std0

    def test_update_pops_pending_once(self):
        store = ContextualStore()
        store.note_context("rec-1", "lane", _x())
        assert store.update("rec-1", "m1", 1.0)
        assert not store.update("rec-1", "m1", 1.0)  # replay is a no-op
        assert not store.update("rec-never", "m1", 1.0)

    def test_heads_are_lane_and_model_scoped(self):
        store = ContextualStore()
        x = _x()
        store.note_context("r1", "lane-a", x)
        store.update("r1", "m1", 1.0)
        assert store.head_stats("lane-a", "m1", x)[2] == 1
        assert store.head_stats("lane-b", "m1", x)[2] == 0
        assert store.head_stats("lane-a", "m2", x)[2] == 0


class TestBlend:
    def test_blend_weight_curve(self):
        assert blend_weight(0.0) == 0.0
        assert blend_weight(10.0) == pytest.approx(0.5)
        assert blend_weight(1e9) == pytest.approx(1.0, abs=1e-6)


class TestBlendedSelection:
    def test_propensities_are_sampling_frequencies(self):
        items = [
            ("cheap", 5.0, 5.0, 0.001, 0.6, 0.2, 0.5),
            ("premium", 9.0, 1.0, 0.01, 0.9, 0.1, 0.5),
        ]
        rng = random.Random(7)
        pick, pi = contextual_thompson_select(items, 0.7, rng, samples=512)
        assert pick in pi
        assert sum(pi.values()) == pytest.approx(1.0)
        assert all(0.0 <= p <= 1.0 for p in pi.values())
        # Frequencies must be reproducible from the same seed (they ARE the log).
        pick2, pi2 = contextual_thompson_select(items, 0.7, random.Random(7), samples=512)
        assert (pick, pi) == (pick2, pi2)

    def test_strong_head_dominates_when_cell_is_thin(self):
        # No cell evidence (w_cell=0): the head's belief decides. m_good's head is
        # confidently above tau; m_bad's confidently below.
        items = [
            ("m_bad", 1.0, 1.0, 0.001, 0.1, 0.02, 0.0),
            ("m_good", 1.0, 1.0, 0.01, 0.95, 0.02, 0.0),
        ]
        _, pi = contextual_thompson_select(items, 0.7, random.Random(3), samples=256)
        assert pi["m_good"] > 0.9

    def test_full_cell_weight_reduces_to_beta_sampling(self):
        # w_cell=1: the head numbers are ignored; a hopeless Beta cell loses to a
        # strong one regardless of head optimism.
        items = [
            ("m_weak", 1.0, 19.0, 0.001, 0.99, 0.001, 1.0),
            ("m_strong", 19.0, 1.0, 0.01, 0.01, 0.001, 1.0),
        ]
        _, pi = contextual_thompson_select(items, 0.7, random.Random(5), samples=256)
        assert pi["m_strong"] > 0.9

    def test_empty_items(self):
        assert contextual_thompson_select([], 0.7, random.Random(1)) == ("", {})
