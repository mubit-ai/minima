"""Tests for the advisory shadow (UCB) bandit policy."""

from __future__ import annotations

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.metrics.calibration import _shadow_agreement, routing_health
from minima.recommender import score
from minima.recommender.decisionlog import DecisionRecord, MemoryDecisionLog
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory

_REQ = RecommendRequest(
    task=TaskInput(task="write a python function", task_type="code"), allow_llm_escalation=False
)


def test_ucb_score_alpha_zero_equals_ranking_score():
    assert score.ucb_score(0.6, 0.4, 0.2, 5.0, 0.0) == score.ranking_score(0.6, 0.2, 5.0)


def test_ucb_score_optimism_grows_with_width():
    lo = score.ucb_score(0.6, 0.0, 0.2, 5.0, 1.0)
    hi = score.ucb_score(0.6, 0.5, 0.2, 5.0, 1.0)
    assert hi > lo


async def test_shadow_logs_pick_without_overriding():
    base = Settings(mubit_api_key="t")
    shadow = Settings(mubit_api_key="t", minima_shadow_bandit=True)
    off = await Recommender(
        base, FakeMemory(), CatalogStore(base), RecommendationStore()
    ).recommend(_REQ)
    log = MemoryDecisionLog()
    on = await Recommender(
        shadow, FakeMemory(), CatalogStore(shadow), RecommendationStore(), decision_log=log
    ).recommend(_REQ)
    # the shadow policy must never change the deployed recommendation
    assert on.recommended_model.model_id == off.recommended_model.model_id
    row = log.get(on.recommendation_id)
    assert row is not None and row.shadow_chosen_model_id is not None


def _row(rid: str, chosen: str, shadow: str | None) -> DecisionRecord:
    return DecisionRecord(
        recommendation_id=rid,
        org_id="default",
        lane="l",
        cluster="code:medium",
        task_type="code",
        difficulty="medium",
        fingerprint="fp",
        ts=1.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
        shadow_chosen_model_id=shadow,
    )


def test_shadow_agreement_metric():
    rows = [
        _row("a", "m1", "m1"),  # agree
        _row("b", "m1", "m2"),  # disagree
        _row("c", "m1", None),  # no shadow -> not counted
    ]
    assert _shadow_agreement(rows) == 0.5
    assert routing_health(rows)["shadow_agreement"] == 0.5
    assert routing_health([])["shadow_agreement"] == 0.0
