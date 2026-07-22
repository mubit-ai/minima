"""PR-F structural bets: flag-off inertness + flag-on loops (F1/F2/F3/F4a)."""

from __future__ import annotations

import random

import pytest
from fastapi.testclient import TestClient

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.main import create_app
from minima.memory.recall_utility import RecallUtilityStore
from minima.memory.records import OutcomeRecord
from minima.recommender.engine import Recommender
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.recommend import RecommendRequest
from tests.conftest import TEST_MUBIT_KEY
from tests.factories import FakeMemory, make_evidence

CODE_TASK = "refactor this recursive def foo()"


def _flagged_settings(**over) -> Settings:
    base: dict = {
        "mubit_api_key": "test-key",
        "minima_selection_policy": "argmin",
        "minima_contextual_bandit": True,
        "minima_probe_cold_start": True,
        "minima_recall_utility": True,
        "minima_recall_vote_failure_weight": 2.0,
    }
    base.update(over)
    return Settings(**base)


@pytest.fixture
def flagged_memory() -> FakeMemory:
    return FakeMemory()


@pytest.fixture
def flagged_app(flagged_memory: FakeMemory):
    return create_app(settings=_flagged_settings(), memory=flagged_memory, start_refresh=False)


@pytest.fixture
def flagged_client(flagged_app) -> TestClient:
    with TestClient(
        flagged_app, headers={"Authorization": f"Bearer {TEST_MUBIT_KEY}"}
    ) as test_client:
        yield test_client


def _tenant(app):
    return app.state.passthrough_runtime.resolve(TEST_MUBIT_KEY)


def _recommend(client, memory: FakeMemory) -> dict:
    memory.evidence = [
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"),
        make_evidence("claude-haiku-4-5", 0.9, entry_id="e2", reference_id="r2"),
    ]
    return client.post(
        "/v1/recommend",
        json={
            "task": {"task": CODE_TASK, "task_type": "code", "difficulty": "hard"},
            "constraints": {"candidate_models": ["claude-haiku-4-5", "claude-opus-4-8"]},
        },
    ).json()


class TestDefaultOffInertness:
    def test_default_settings_build_no_stores(self, app, client, fake_memory):
        rec = _recommend(client, fake_memory)
        assert rec["recommendation_id"]
        tenant = _tenant(app)
        assert tenant.contextual is None
        assert tenant.recall_utility is None

    async def test_flag_off_selection_is_bitwise_identical(self):
        # Same seed, thompson policy: an engine WITH structural-bet stores attached but
        # flags off must sample exactly like the legacy engine.
        def build(with_stores: bool) -> Recommender:
            settings = Settings(mubit_api_key="t", minima_selection_policy="thompson")
            kwargs: dict = {}
            if with_stores:
                from minima.recommender.contextual import ContextualStore

                kwargs = {
                    "contextual": ContextualStore(),
                    "recall_utility": RecallUtilityStore(),
                }
            return Recommender(
                settings,
                FakeMemory(),
                CatalogStore(settings),
                RecommendationStore(),
                rng=random.Random(42),
                **kwargs,
            )

        req = RecommendRequest(task=TaskInput(task=CODE_TASK), allow_llm_escalation=False)
        legacy = await build(False).recommend(req)
        wired = await build(True).recommend(req)
        assert wired.recommended_model.model_id == legacy.recommended_model.model_id
        assert [r.model_id for r in wired.ranked] == [r.model_id for r in legacy.ranked]
        assert wired.selection_policy == legacy.selection_policy


class TestContextualLoop:
    def test_trusted_feedback_updates_the_head(self, flagged_app, flagged_client, flagged_memory):
        rec = _recommend(flagged_client, flagged_memory)
        tenant = _tenant(flagged_app)
        assert tenant.contextual is not None
        fb = flagged_client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "success",
                "quality_score": 0.95,
                "evidence_source": "judge",
            },
        ).json()
        assert fb["accepted"] is True
        _, _, n = tenant.contextual.head_stats(
            "minima:default", "claude-haiku-4-5", [1.0] * 23
        )
        assert n == 1

    def test_untrusted_feedback_never_touches_the_head(
        self, flagged_app, flagged_client, flagged_memory
    ):
        rec = _recommend(flagged_client, flagged_memory)
        tenant = _tenant(flagged_app)
        flagged_client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "success",
                "judged": False,
            },
        )
        assert tenant.contextual is not None
        _, _, n = tenant.contextual.head_stats(
            "minima:default", "claude-haiku-4-5", [1.0] * 23
        )
        assert n == 0

    async def test_contextual_thompson_logs_sampled_propensities(self):
        settings = _flagged_settings(minima_selection_policy="thompson")
        from minima.recommender.contextual import ContextualStore
        from minima.recommender.decisionlog import MemoryDecisionLog

        decision_log = MemoryDecisionLog(30)
        engine = Recommender(
            settings,
            FakeMemory(),
            CatalogStore(settings),
            RecommendationStore(),
            decision_log=decision_log,
            rng=random.Random(11),
            contextual=ContextualStore(),
        )
        resp = await engine.recommend(
            RecommendRequest(task=TaskInput(task=CODE_TASK), allow_llm_escalation=False)
        )
        assert resp.selection_policy == "thompson"
        rows = decision_log.rows()
        assert len(rows) == 1
        pi = {c.model_id: c.propensity for c in rows[0].candidates}
        assert sum(pi.values()) == pytest.approx(1.0, abs=1e-6)
        assert pi[resp.recommended_model.model_id] > 0.0


class TestProbeColdStartWiring:
    async def test_capless_candidate_borrows_a_neighbor_prior(self):
        settings = _flagged_settings()
        catalog_store = CatalogStore(settings)
        cards = catalog_store.get().cards
        stripped = next(c for c in cards if c.model_id == "claude-haiku-4-5")
        stripped.capability_by_task_type = {}
        stripped.capability_priors = {}
        engine = Recommender(settings, FakeMemory(), catalog_store, RecommendationStore())
        resp = await engine.recommend(
            RecommendRequest(
                task=TaskInput(task=CODE_TASK, task_type="code"),
                constraints=Constraints(
                    candidate_models=["claude-haiku-4-5", "claude-opus-4-8"]
                ),
                allow_llm_escalation=False,
            )
        )
        haiku = next(r for r in resp.ranked if r.model_id == "claude-haiku-4-5")
        # The flat 0.5 default is replaced by a neighbor-borrowed prior.
        assert haiku.predicted_success != pytest.approx(0.5)

    async def test_flag_off_keeps_the_flat_default(self):
        settings = Settings(mubit_api_key="t", minima_selection_policy="argmin")
        catalog_store = CatalogStore(settings)
        stripped = next(
            c for c in catalog_store.get().cards if c.model_id == "claude-haiku-4-5"
        )
        stripped.capability_by_task_type = {}
        stripped.capability_priors = {}
        engine = Recommender(settings, FakeMemory(), catalog_store, RecommendationStore())
        resp = await engine.recommend(
            RecommendRequest(
                task=TaskInput(task=CODE_TASK, task_type="code"),
                constraints=Constraints(
                    candidate_models=["claude-haiku-4-5", "claude-opus-4-8"]
                ),
                allow_llm_escalation=False,
            )
        )
        haiku = next(r for r in resp.ranked if r.model_id == "claude-haiku-4-5")
        assert haiku.predicted_success == pytest.approx(0.5)


class TestRecallUtilityLoop:
    def test_reinforcement_credits_and_failure_votes_debit(
        self, flagged_app, flagged_client, flagged_memory
    ):
        rec = _recommend(flagged_client, flagged_memory)
        tenant = _tenant(flagged_app)
        assert tenant.recall_utility is not None
        durable = OutcomeRecord(
            model_id="claude-haiku-4-5",
            task_type="code",
            difficulty="hard",
            task_cluster="code:hard",
            outcome="success",
            quality_score=0.9,
            evidence_source="judge",
        )
        flagged_memory.deref_results["r1"] = make_evidence(
            "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
        )
        flagged_memory.deref_results["r1"].record = durable
        flagged_client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "failure",
                "quality_score": 0.1,
                "evidence_source": "judge",
            },
        )
        lane = "minima:default"
        # Reinforced entries earned credits; the failure vote debited its target.
        assert tenant.recall_utility.multiplier(lane, ("e2",)) > 1.0
        assert tenant.recall_utility.multiplier(lane, ("r1",)) < 1.0

    def test_next_recommend_reweights_recalled_evidence(
        self, flagged_app, flagged_client, flagged_memory
    ):
        tenant = _tenant(flagged_app)
        assert tenant.recall_utility is not None
        tenant.recall_utility.debit("minima:default", "e1", 20.0)
        rec = _recommend(flagged_client, flagged_memory)
        assert rec["recommendation_id"]
        # The engine mutates the recalled row's similarity weight in place.
        downweighted = next(e for e in flagged_memory.evidence if e.entry_id == "e1")
        untouched = next(e for e in flagged_memory.evidence if e.entry_id == "e2")
        assert downweighted.score < untouched.score


class TestHarmfulVoteWeight:
    def test_failed_outcome_votes_carry_the_configured_weight(
        self, flagged_client, flagged_memory
    ):
        rec = _recommend(flagged_client, flagged_memory)
        durable = OutcomeRecord(
            model_id="claude-haiku-4-5",
            task_type="code",
            difficulty="hard",
            task_cluster="code:hard",
            outcome="success",
            quality_score=0.9,
            evidence_source="judge",
        )
        flagged_memory.deref_results["r1"] = make_evidence(
            "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
        )
        flagged_memory.deref_results["r1"].record = durable
        flagged_client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "failure",
                "quality_score": 0.1,
                "evidence_source": "judge",
            },
        )
        votes = [w for w in flagged_memory.remembered if w["idempotency_key"].startswith("rv:")]
        assert len(votes) == 1
        voted = votes[0]["record"]
        assert (voted.recall_n, voted.recall_success_mass) == (2, 0.0)

    def test_success_votes_stay_single_weight(self, flagged_client, flagged_memory):
        rec = _recommend(flagged_client, flagged_memory)
        durable = OutcomeRecord(
            model_id="claude-haiku-4-5",
            task_type="code",
            difficulty="hard",
            task_cluster="code:hard",
            outcome="success",
            quality_score=0.9,
            evidence_source="judge",
        )
        flagged_memory.deref_results["r1"] = make_evidence(
            "claude-haiku-4-5", 0.9, entry_id="e1", reference_id="r1"
        )
        flagged_memory.deref_results["r1"].record = durable
        flagged_client.post(
            "/v1/feedback",
            json={
                "recommendation_id": rec["recommendation_id"],
                "chosen_model_id": "claude-haiku-4-5",
                "outcome": "success",
                "quality_score": 0.9,
                "evidence_source": "judge",
            },
        )
        votes = [w for w in flagged_memory.remembered if w["idempotency_key"].startswith("rv:")]
        assert len(votes) == 1
        voted = votes[0]["record"]
        assert (voted.recall_n, voted.recall_success_mass) == (1, 1.0)
