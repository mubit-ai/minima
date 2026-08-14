"""The eval harness must measure the system that ships, not a lookalike.

These are hermetic guards on the three ways the RouterBench harness silently diverged
from ``/recommend`` — each one biased the reported numbers, and none of them could fail
loudly because the eval suite skips without a live Mubit. They run offline against fakes
so a regression shows up in `make test`, not in a benchmark result nobody can reproduce.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import pytest

from minima.memory.keys import build_content, versioned_cluster
from minima.recommender.types import ModelAggregate
from minima.schemas.common import TaskType
from tests.eval import harness


@dataclass
class _Recall:
    outcome_evidence: list


class _FakeMemory:
    """Records what it was asked, so the harness's read path can be asserted on."""

    def __init__(self, lookup_result=None):
        self.recall_queries: list[str] = []
        self.lookup_matches: list[list[dict]] = []
        self._lookup_result = lookup_result

    async def recall(self, *, query, lane, limit, timeout_ms=None, **kw):
        self.recall_queries.append(query)
        return _Recall(outcome_evidence=[])

    async def lookup(self, *, lane, match, limit=256):
        self.lookup_matches.append(match)
        return self._lookup_result


def _row(prompt="Refactor the recursive parser", tt=TaskType.code):
    return harness.Row(prompt=prompt, task_type=tt, scores={"a": 1.0}, costs={"a": 0.1}, fp="f")


@pytest.mark.asyncio
async def test_recall_queries_the_content_gist_not_the_raw_prompt(settings):
    """Outcome records are embedded from build_content; querying with the bare prompt
    compares a bare prompt against tagged gists and depresses similarity."""
    mem, row = _FakeMemory(), _row()
    await harness._recall_aggs(mem, "lane", row, ["a"], settings)

    assert mem.recall_queries == [build_content(row.task_type.value, "medium", row.prompt)]
    assert row.prompt not in mem.recall_queries  # the old behaviour


@pytest.mark.asyncio
async def test_keyed_lookup_is_issued_for_every_candidate_cell(settings):
    """The lookup channel is what makes production immune to ANN starvation; an eval
    without it under-measures evidence exactly where the candidate set is widest."""
    mem = _FakeMemory()
    await harness._recall_aggs(mem, "lane", _row(), ["a", "b", "c"], settings)

    cluster = versioned_cluster("code", "medium", settings.minima_cluster_key_version)
    assert mem.lookup_matches == [
        [{"kind": "outcome", "task_cluster": cluster, "model_id": m} for m in ("a", "b", "c")]
    ]


@pytest.mark.asyncio
async def test_degraded_lookup_channel_is_reported_not_swallowed(settings):
    """None from lookup means the channel is DOWN, not that there were no records. A run
    that silently falls back to recall-only evidence must not read as a clean run."""
    down = _FakeMemory(lookup_result=None)
    up = _FakeMemory(lookup_result=[])

    assert (await harness._recall_aggs(down, "lane", _row(), ["a"], settings))[3] is True
    assert (await harness._recall_aggs(up, "lane", _row(), ["a"], settings))[3] is False


def _cards_and_aggs():
    from datetime import UTC, datetime

    from minima.schemas.models_catalog import ModelCard

    cards, aggs = {}, {}
    for mid, price, succ in (("cheap", 0.2, 6.0), ("mid", 2.0, 9.0), ("dear", 30.0, 10.0)):
        cards[mid] = ModelCard(
            model_id=mid, provider="p", display_name=mid,
            input_cost_per_mtok=price, output_cost_per_mtok=price, context_window=8192,
            cost_source="t", cost_fetched_at=datetime.now(UTC), cost_stale=False,
        )
        agg = ModelAggregate(model_id=mid)
        agg.weight_sum, agg.weighted_success, agg.n = 10.0, succ, 10
        aggs[mid] = agg
    return cards, aggs


def test_pick_follows_the_shipping_selection_policy(settings):
    """`minima_selection_policy` defaults to thompson. Scoring a hardcoded argmin reports
    a frontier for a policy nobody runs and shows exploration cost as exactly zero.

    The shared `settings` fixture pins argmin for determinism, so the shipped default is
    asserted on a bare Settings — that default is the thing this guard is about.
    """
    from minima.config import Settings

    assert Settings(mubit_api_key="k").minima_selection_policy == "thompson"
    cards, aggs = _cards_and_aggs()
    deployed = settings.model_copy(update={"minima_selection_policy": "thompson"})

    def picks(rng):
        return {
            harness._pick(aggs, cards, TaskType.code, 5.0, 500, deployed, None, "", rng)
            for _ in range(40)
        }

    # rng=None => deterministic argmin intent (what the crosscheck compares).
    assert len(picks(None)) == 1
    # A live rng => the posterior actually gets sampled, so picks vary.
    assert len(picks(random.Random(7))) > 1


def test_pick_is_reproducible_under_a_seeded_rng(settings):
    cards, aggs = _cards_and_aggs()
    deployed = settings.model_copy(update={"minima_selection_policy": "thompson"})
    runs = [
        [
            harness._pick(aggs, cards, TaskType.code, 5.0, 500, deployed, None, "",
                          random.Random(11))
            for _ in range(20)
        ]
        for _ in range(2)
    ]
    assert runs[0] == runs[1]


def test_argmin_policy_setting_disables_sampling_even_with_an_rng(settings):
    cards, aggs = _cards_and_aggs()
    argmin = settings.model_copy(update={"minima_selection_policy": "argmin"})
    got = {
        harness._pick(aggs, cards, TaskType.code, 5.0, 500, argmin, None, "", random.Random(3))
        for _ in range(40)
    }
    assert len(got) == 1
