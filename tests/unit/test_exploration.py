from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender import score
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory

CODE_TASK = TaskInput(task="refactor a recursive parser into an iterative loop", task_type="code")


def test_with_exploration_bonus_off_is_identity():
    assert score.with_exploration_bonus(0.6, 0.0, 0.0) == 0.6


def test_with_exploration_bonus_scales_by_uncertainty():
    # Cold (confidence 0) gets the full bonus; well-evidenced (confidence 1) gets none.
    assert score.with_exploration_bonus(0.6, 0.0, 0.2) == 0.8
    assert score.with_exploration_bonus(0.6, 1.0, 0.2) == 0.6
    assert score.with_exploration_bonus(0.95, 0.0, 0.2) == 1.0  # clamped


def _engine(settings: Settings) -> Recommender:
    return Recommender(settings, FakeMemory(), CatalogStore(settings), RecommendationStore())


async def test_exploration_bonus_promotes_cheaper_underexplored_model():
    # Cold start, code/hard, slider 5 -> tau 0.735. gpt-4o-mini (prior 0.68, cheapest)
    # is below tau without exploration, so a pricier model is picked. A small bonus
    # lifts the cheap, unproven model over the bar and it becomes the recommendation.
    req = RecommendRequest(task=CODE_TASK, allow_llm_escalation=False)

    off = await _engine(Settings(mubit_api_key="t", minima_exploration_bonus=0.0)).recommend(req)
    on = await _engine(Settings(mubit_api_key="t", minima_exploration_bonus=0.1)).recommend(req)

    assert off.recommended_model.model_id != "gpt-4o-mini"
    assert on.recommended_model.model_id == "gpt-4o-mini"
    assert on.recommended_model.est_cost_usd <= off.recommended_model.est_cost_usd

    off_mini = next(m for m in off.ranked if m.model_id == "gpt-4o-mini")
    on_mini = next(m for m in on.ranked if m.model_id == "gpt-4o-mini")
    assert on_mini.predicted_success > off_mini.predicted_success
