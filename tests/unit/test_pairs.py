"""Preference-pair assembly, win-rate math, and the bounded prior adjustment."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from minima.catalog.store import Catalog, CatalogStore
from minima.config import Settings
from minima.recommender.decisionlog import DecisionRecord, MemoryDecisionLog
from minima.recommender.engine import Recommender
from minima.recommender.pairs import (
    MemoryPairStore,
    OrgScopedPairStore,
    PreferencePair,
    assemble_pair,
    pair_prior_adjustment,
)
from minima.recommender.recstore import RecommendationStore
from minima.schemas.common import Constraints, TaskInput
from minima.schemas.feedback import FeedbackRequest
from minima.schemas.models_catalog import ModelCard
from minima.schemas.recommend import RecommendRequest
from tests.factories import FakeMemory


def _parent(
    *,
    outcome: str | None = "failure",
    evidence_source: str | None = "judge",
    cluster: str = "code:hard",
    chosen: str = "haiku",
    realized: str | None = None,
) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id="p1",
        org_id="org-a",
        lane="minima:default",
        cluster=cluster,
        task_type="code",
        difficulty="hard",
        fingerprint="fp",
        ts=0.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id=chosen,
        escalated=False,
    )
    rec.realized_outcome = outcome
    rec.realized_model_id = realized or (chosen if outcome is not None else None)
    rec.evidence_source = evidence_source
    return rec


def _child(
    *,
    outcome: str = "success",
    chosen: str = "opus",
    escalation_reason: str | None = "judge_failed",
) -> FeedbackRequest:
    return FeedbackRequest(
        recommendation_id="c1",
        chosen_model_id=chosen,
        outcome=outcome,
        parent_rec_id="p1",
        escalation_reason=escalation_reason,
    )


class TestAssemblePair:
    def test_qualifying_chain_produces_pair(self):
        pair = assemble_pair(
            _parent(), _child(), child_cluster="code:hard", child_evidence_source="gate"
        )
        assert pair is not None
        assert (pair.winner_model_id, pair.loser_model_id) == ("opus", "haiku")
        assert pair.cluster == "code:hard"
        assert pair.org_id == "org-a"
        assert pair.evidence == "gate"
        assert pair.escalation_reason == "judge_failed"

    def test_parent_not_failed_disqualifies(self):
        for outcome in ("success", "partial", None):
            pair = assemble_pair(
                _parent(outcome=outcome),
                _child(),
                child_cluster="code:hard",
                child_evidence_source="gate",
            )
            assert pair is None

    def test_untrusted_parent_needs_gate_failed_reason(self):
        parent = _parent(evidence_source=None)
        assert (
            assemble_pair(
                parent,
                _child(escalation_reason="judge_failed"),
                child_cluster="code:hard",
                child_evidence_source="gate",
            )
            is None
        )
        assert (
            assemble_pair(
                parent,
                _child(escalation_reason="gate_failed"),
                child_cluster="code:hard",
                child_evidence_source="gate",
            )
            is not None
        )

    def test_child_must_succeed_with_gate_or_judge_evidence(self):
        assert (
            assemble_pair(
                _parent(),
                _child(outcome="failure"),
                child_cluster="code:hard",
                child_evidence_source="gate",
            )
            is None
        )
        for source in ("human", "none"):
            assert (
                assemble_pair(
                    _parent(), _child(), child_cluster="code:hard", child_evidence_source=source
                )
                is None
            )
        assert (
            assemble_pair(
                _parent(), _child(), child_cluster="code:hard", child_evidence_source="judge"
            )
            is not None
        )

    def test_cross_cluster_disqualifies(self):
        pair = assemble_pair(
            _parent(cluster="qa:easy"),
            _child(),
            child_cluster="code:hard",
            child_evidence_source="gate",
        )
        assert pair is None

    def test_same_model_retry_disqualifies(self):
        pair = assemble_pair(
            _parent(chosen="opus"),
            _child(chosen="opus"),
            child_cluster="code:hard",
            child_evidence_source="gate",
        )
        assert pair is None

    def test_loser_is_realized_model_when_divergent(self):
        pair = assemble_pair(
            _parent(chosen="haiku", realized="sonnet"),
            _child(),
            child_cluster="code:hard",
            child_evidence_source="gate",
        )
        assert pair is not None
        assert pair.loser_model_id == "sonnet"


def _pair(winner: str, loser: str, org_id: str = "org-a") -> PreferencePair:
    return PreferencePair(
        org_id=org_id,
        lane="minima:default",
        cluster="code:hard",
        winner_model_id=winner,
        loser_model_id=loser,
        escalation_reason="gate_failed",
        ts=1.0,
        evidence="gate",
    )


class TestPairStore:
    def test_win_rates_counts_both_directions(self):
        store = OrgScopedPairStore(MemoryPairStore(), "org-a")
        store.put(_pair("a", "b"))
        store.put(_pair("a", "b"))
        store.put(_pair("b", "a"))
        rates = store.win_rates("code:hard")
        assert rates[("a", "b")] == (2, 3)
        assert rates[("b", "a")] == (1, 3)

    def test_one_sided_pair_exposes_zero_win_reverse_key(self):
        store = OrgScopedPairStore(MemoryPairStore(), "org-a")
        store.put(_pair("a", "b"))
        rates = store.win_rates("code:hard")
        assert rates[("a", "b")] == (1, 1)
        assert rates[("b", "a")] == (0, 1)

    def test_org_isolation(self):
        backend = MemoryPairStore()
        OrgScopedPairStore(backend, "org-a").put(_pair("a", "b"))
        assert OrgScopedPairStore(backend, "org-b").win_rates("code:hard") == {}

    def test_cluster_isolation(self):
        store = OrgScopedPairStore(MemoryPairStore(), "org-a")
        store.put(_pair("a", "b"))
        assert store.win_rates("qa:easy") == {}

    def test_retention_cap(self):
        store = OrgScopedPairStore(MemoryPairStore(retention=2), "org-a")
        for _ in range(3):
            store.put(_pair("a", "b"))
        assert store.win_rates("code:hard")[("a", "b")] == (2, 2)


class TestPairPriorAdjustment:
    def test_below_min_n_is_a_noop(self):
        rates = {("a", "b"): (2, 2), ("b", "a"): (0, 2)}
        assert pair_prior_adjustment(0.6, "a", rates, min_n=3, weight=0.2) == 0.6

    def test_winner_nudged_up_loser_down_bounded_by_half_weight(self):
        rates = {("a", "b"): (3, 3), ("b", "a"): (0, 3)}
        assert pair_prior_adjustment(0.6, "a", rates, min_n=3, weight=0.2) == pytest.approx(0.7)
        assert pair_prior_adjustment(0.6, "b", rates, min_n=3, weight=0.2) == pytest.approx(0.5)

    def test_even_record_is_a_noop(self):
        rates = {("a", "b"): (2, 4), ("b", "a"): (2, 4)}
        assert pair_prior_adjustment(0.6, "a", rates, min_n=3, weight=0.2) == pytest.approx(0.6)

    def test_clamped_to_unit_interval(self):
        rates = {("a", "b"): (5, 5), ("b", "a"): (0, 5)}
        assert pair_prior_adjustment(0.98, "a", rates, min_n=3, weight=0.2) == 1.0
        assert pair_prior_adjustment(0.01, "b", rates, min_n=3, weight=0.2) == 0.0

    def test_unknown_model_untouched(self):
        rates = {("a", "b"): (3, 3), ("b", "a"): (0, 3)}
        assert pair_prior_adjustment(0.5, "c", rates, min_n=3, weight=0.2) == 0.5


def _catalog(settings: Settings) -> CatalogStore:
    cards = [
        ModelCard(model_id="a", provider="p", input_cost_per_mtok=1.0, output_cost_per_mtok=5.0),
        ModelCard(model_id="b", provider="p", input_cost_per_mtok=1.0, output_cost_per_mtok=5.0),
    ]
    store = CatalogStore(settings)
    store.set(
        Catalog(
            cards=cards,
            version="t",
            refreshed_at=datetime.now(UTC),
            cost_source="t",
            stale_after_seconds=10**9,
        )
    )
    return store


REQ = RecommendRequest(
    task=TaskInput(task="write a function", task_type="code", difficulty="hard"),
    constraints=Constraints(candidate_models=["a", "b"]),
    allow_llm_escalation=False,
)


def _seeded_pair_store(n: int = 3) -> OrgScopedPairStore:
    store = OrgScopedPairStore(MemoryPairStore(), "default")
    for _ in range(n):
        store.put(_pair("a", "b", org_id="default"))
    return store


def _predicted(resp) -> dict[str, float]:
    return {m.model_id: m.predicted_success for m in resp.ranked}


class TestScoringIntegration:
    async def test_flag_off_ignores_pairs(self):
        settings = Settings(mubit_api_key="t", minima_selection_policy="argmin")
        engine = Recommender(
            settings,
            FakeMemory(),
            _catalog(settings),
            RecommendationStore(),
            pair_store=_seeded_pair_store(),
        )
        predicted = _predicted(await engine.recommend(REQ))
        assert predicted["a"] == predicted["b"]

    async def test_flag_on_nudges_winner_over_loser(self):
        settings = Settings(
            mubit_api_key="t", minima_selection_policy="argmin", minima_pairs_enabled=True
        )
        engine = Recommender(
            settings,
            FakeMemory(),
            _catalog(settings),
            RecommendationStore(),
            pair_store=_seeded_pair_store(),
        )
        predicted = _predicted(await engine.recommend(REQ))
        assert predicted["a"] > predicted["b"]

    async def test_flag_on_but_below_min_n_is_a_noop(self):
        settings = Settings(
            mubit_api_key="t", minima_selection_policy="argmin", minima_pairs_enabled=True
        )
        engine = Recommender(
            settings,
            FakeMemory(),
            _catalog(settings),
            RecommendationStore(),
            pair_store=_seeded_pair_store(n=2),
        )
        predicted = _predicted(await engine.recommend(REQ))
        assert predicted["a"] == predicted["b"]


class TestDeferralWarning:
    async def test_high_deferral_rate_warns_for_cluster(self):
        settings = Settings(mubit_api_key="t", minima_selection_policy="argmin")
        decision_log = MemoryDecisionLog()
        for i in range(5):
            rec = _parent()
            rec.recommendation_id = f"d{i}"
            rec.escalation_reason = "gate_failed"
            decision_log.put(rec, org_id="default")
        engine = Recommender(
            settings,
            FakeMemory(),
            _catalog(settings),
            RecommendationStore(),
            decision_log=decision_log,
        )
        resp = await engine.recommend(REQ)
        assert "escalation_rate_high:code:hard" in resp.warnings

    async def test_low_or_thin_deferral_stays_quiet(self):
        settings = Settings(mubit_api_key="t", minima_selection_policy="argmin")
        decision_log = MemoryDecisionLog()
        for i in range(4):
            rec = _parent()
            rec.recommendation_id = f"d{i}"
            rec.escalation_reason = "gate_failed"
            decision_log.put(rec, org_id="default")
        engine = Recommender(
            settings,
            FakeMemory(),
            _catalog(settings),
            RecommendationStore(),
            decision_log=decision_log,
        )
        resp = await engine.recommend(REQ)
        assert not any(w.startswith("escalation_rate_high") for w in resp.warnings)
