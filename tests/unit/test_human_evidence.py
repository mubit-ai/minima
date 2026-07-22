"""Bounded human evidence: caller-asserted labels weigh less than gate/judge ones."""

from __future__ import annotations

import pytest

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.aggregate import aggregate_by_model
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, Difficulty, TaskInput, TaskType
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory, make_evidence


def test_human_record_weighs_a_fraction_of_an_identical_judge_record():
    evidence = [
        make_evidence("a", 1.0, entry_id="1", score=1.0, evidence_source="human"),
        make_evidence("b", 1.0, entry_id="2", score=1.0, evidence_source="judge"),
        make_evidence("c", 1.0, entry_id="3", score=1.0, evidence_source="gate"),
    ]
    aggs = aggregate_by_model(evidence, human_weight=0.6)
    assert aggs["a"].weight_sum == pytest.approx(0.6 * aggs["b"].weight_sum)
    assert aggs["c"].weight_sum == pytest.approx(aggs["b"].weight_sum)


def test_human_weight_default_is_full_and_clamped():
    human = [make_evidence("a", 1.0, entry_id="1", score=1.0, evidence_source="human")]
    judge = [make_evidence("a", 1.0, entry_id="1", score=1.0, evidence_source="judge")]
    assert (
        aggregate_by_model(human)["a"].weight_sum
        == aggregate_by_model(judge)["a"].weight_sum
    )
    assert aggregate_by_model(human, human_weight=7.0)["a"].weight_sum == pytest.approx(
        aggregate_by_model(judge)["a"].weight_sum
    )
    assert aggregate_by_model(human, human_weight=-1.0)["a"].weight_sum == 0.0


def test_seed_records_keep_their_own_weighting():
    seeded = [
        make_evidence("a", 1.0, entry_id="1", score=1.0, source_dataset="routerbench")
    ]
    aggs = aggregate_by_model(seeded, seed_weight=0.5, human_weight=0.6)
    baseline = aggregate_by_model(seeded, seed_weight=0.5)
    assert aggs["a"].weight_sum == pytest.approx(baseline["a"].weight_sum)


async def test_single_human_failure_still_flips_at_cold_start():
    # Margin 0 isolates the evidence effect: flash wins cold, then ONE down-weighted
    # human failure (0.6 x full keyed weight, still >> the ~0.12 flip threshold)
    # drops it below tau.
    settings = Settings(
        mubit_api_key="t", minima_selection_policy="argmin", minima_cold_start_margin=0.0
    )

    async def _recommend(memory: FakeMemory):
        engine = Recommender(
            settings, memory, CatalogStore(settings), RecommendationStore()
        )
        return await engine.recommend(
            RecommendRequest(
                task=TaskInput(
                    task="refactor this recursive def foo()",
                    task_type=TaskType.code,
                    difficulty=Difficulty.hard,
                ),
                constraints=Constraints(
                    candidate_models=[
                        "gemini-2.5-flash",
                        "gemini-3-flash-preview",
                        "claude-haiku-4-5",
                        "claude-sonnet-4-6",
                        "gemini-2.5-pro",
                        "claude-opus-4-8",
                    ]
                ),
                allow_llm_escalation=False,
            )
        )

    cold = await _recommend(FakeMemory())
    assert cold.recommended_model.model_id == "gemini-2.5-flash"

    failure = [
        make_evidence("gemini-2.5-flash", 0.1, entry_id="e1", evidence_source="human")
    ]
    flipped = await _recommend(FakeMemory(failure))
    assert flipped.recommended_model.model_id != "gemini-2.5-flash"
