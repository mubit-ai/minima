"""The keyed-lookup double must discriminate, or the rig cannot see a routing bug.

FakeMemory.lookup recorded its `match` argument and then returned every seeded record
regardless. Any test asserting cluster-keyed behaviour — dual-read windows, key-version
migration, per-(cluster, model) cells — therefore passed no matter which key the engine
actually asked Mubit for. These tests pin the filter so it cannot regress to a pass-through.
"""

from __future__ import annotations

import pytest

from tests.factories import FakeMemory, make_evidence

OUTCOME = {"kind": "outcome"}


def _mem(*evidence) -> FakeMemory:
    mem = FakeMemory()
    mem.lookup_results = list(evidence)
    return mem


async def _lookup(mem: FakeMemory, match: list[dict]):
    return await mem.lookup(lane="lane", match=match)


@pytest.mark.anyio
async def test_wrong_cluster_returns_nothing():
    mem = _mem(make_evidence("m1", 0.9, entry_id="e1", task_cluster="code:hard"))
    assert await _lookup(mem, [{**OUTCOME, "task_cluster": "code:easy", "model_id": "m1"}]) == []


@pytest.mark.anyio
async def test_wrong_model_returns_nothing():
    mem = _mem(make_evidence("m1", 0.9, entry_id="e1", task_cluster="code:hard"))
    assert await _lookup(mem, [{**OUTCOME, "task_cluster": "code:hard", "model_id": "m2"}]) == []


@pytest.mark.anyio
async def test_clause_must_match_on_every_field():
    """A clause is a conjunction: the right cluster with the wrong model is not a hit."""
    mem = _mem(make_evidence("m1", 0.9, entry_id="e1", task_cluster="code:hard"))
    match = [{**OUTCOME, "task_cluster": "code:hard", "model_id": "m2"}]
    assert await _lookup(mem, match) == []


@pytest.mark.anyio
async def test_match_is_a_disjunction_of_clauses():
    """The engine sends one clause per (read-version key x candidate); any may hit."""
    active = make_evidence("m1", 0.9, entry_id="a1", task_cluster="code:hard:v2")
    legacy = make_evidence("m1", 0.9, entry_id="l1", task_cluster="code:hard")
    other = make_evidence("m9", 0.9, entry_id="x1", task_cluster="code:hard")
    mem = _mem(active, legacy, other)
    hits = await _lookup(
        mem,
        [
            {**OUTCOME, "task_cluster": "code:hard:v2", "model_id": "m1"},
            {**OUTCOME, "task_cluster": "code:hard", "model_id": "m1"},
        ],
    )
    assert {e.entry_id for e in hits} == {"a1", "l1"}


@pytest.mark.anyio
async def test_limit_is_applied():
    mem = _mem(
        *(make_evidence("m1", 0.9, entry_id=f"e{i}", task_cluster="code:hard") for i in range(5))
    )
    hits = await mem.lookup(
        lane="lane", match=[{**OUTCOME, "task_cluster": "code:hard", "model_id": "m1"}], limit=2
    )
    assert len(hits) == 2


@pytest.mark.anyio
async def test_kind_only_clause_still_matches_everything():
    """`kind` filters the Mubit entry upstream, not the parsed record — so it is not a
    discriminator here, and a clause carrying only `kind` behaves as it would live."""
    mem = _mem(make_evidence("m1", 0.9, entry_id="e1", task_cluster="code:hard"))
    assert len(await _lookup(mem, [OUTCOME])) == 1


@pytest.mark.anyio
async def test_degraded_channel_still_returns_none():
    mem = FakeMemory()
    mem.lookup_results = None
    assert await _lookup(mem, [OUTCOME]) is None
