from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender import score
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory

CODE_TASK = TaskInput(task="refactor a recursive parser into an iterative loop", task_type="code")

# Constrain to 3 models so gpt-4o-mini (prior=0.68) is in the candidate set.
# Without constraints max_candidates=8 cuts off gpt-4o-mini (ranked #10 by code prior).
# At slider=5 tau=0.735: gpt-4o-mini is below tau (ineligible without bonus) while flash
# (prior=0.74) is just above. A bonus of 0.1 lifts gpt-4o-mini to 0.78 making it cheapest.
_EXPLORATION_CONSTRAINTS = Constraints(candidate_models=["gpt-4o-mini", "gemini-2.5-flash", "gemini-2.5-pro"])


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
    # Cold start, code task, slider 5 -> tau 0.735.
    # Candidate set constrained to 3 models so gpt-4o-mini (prior 0.68) is included.
    # Without exploration: gpt-4o-mini < tau → ineligible; flash (0.74 > tau) is cheapest eligible.
    # With bonus=0.1 (cold confidence=0): gpt-4o-mini → 0.78 > tau → eligible and cheapest.
    req = RecommendRequest(task=CODE_TASK, allow_llm_escalation=False, constraints=_EXPLORATION_CONSTRAINTS)

    off = await _engine(Settings(mubit_api_key="t", minima_exploration_bonus=0.0)).recommend(req)
    on = await _engine(Settings(mubit_api_key="t", minima_exploration_bonus=0.1)).recommend(req)

    assert off.recommended_model.model_id != "gpt-4o-mini"
    assert on.recommended_model.model_id == "gpt-4o-mini"
    assert on.recommended_model.est_cost_usd <= off.recommended_model.est_cost_usd

    off_mini = next(m for m in off.ranked if m.model_id == "gpt-4o-mini")
    on_mini = next(m for m in on.ranked if m.model_id == "gpt-4o-mini")
    assert on_mini.predicted_success > off_mini.predicted_success
