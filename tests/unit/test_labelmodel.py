"""Weak-supervision label model (D1) + surrogate index (D3): EM recovery, source
construction, anchoring, min-n gates, clamps, and the engine's flag gating."""

from __future__ import annotations

import random
import time

import pytest

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.recommender.decisionlog import DecisionRecord, MemoryDecisionLog
from minima.recommender.engine import Recommender
from minima.recommender.labelmodel import (
    ANCHOR_ACCURACY,
    SURROGATE_CLAMP,
    FeedbackSignals,
    SignalCache,
    SourceVotes,
    build_votes,
    fit_label_model,
    fit_lane_label_scores,
    fit_surrogate,
    surrogate_predict,
)
from minima.recommender.recstore import RecommendationStore
from tests.factories import FakeMemory


def _row(
    rec_id: str,
    *,
    source: str | None = None,
    outcome: str | None = None,
    quality: float | None = None,
    output_tokens: int | None = None,
    latency_ms: int | None = None,
    cost_usd: float | None = None,
    lane: str = "minima:default",
) -> DecisionRecord:
    r = DecisionRecord(
        recommendation_id=rec_id,
        org_id="default",
        lane=lane,
        cluster="code:hard",
        task_type="code",
        difficulty="hard",
        fingerprint="f",
        ts=time.time(),
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id="m",
        escalated=False,
    )
    if outcome is not None:
        r.realized_model_id = "m"
        r.realized_outcome = outcome
        r.realized_quality = quality
        r.realized_output_tokens = output_tokens
        r.realized_latency_ms = latency_ms
        r.realized_cost_usd = cost_usd
        r.evidence_source = source
    return r


# --------------------------------------------------------------- Dawid-Skene EM


def test_dawid_skene_recovers_planted_accuracies():
    rng = random.Random(7)
    labeled: list[tuple[int, SourceVotes]] = []
    for i in range(600):
        y = 1 if rng.random() < 0.6 else 0
        votes: dict[str, int] = {}
        if rng.random() < 0.3:
            votes["gate"] = y if rng.random() < 0.98 else 1 - y
        votes["judge"] = y if rng.random() < 0.8 else 1 - y
        votes["retried"] = y if rng.random() < 0.65 else 1 - y
        labeled.append((y, SourceVotes(rec_id=f"r{i}", votes=votes)))

    fit = fit_label_model([r for _, r in labeled])

    assert fit.accuracies["gate"] == ANCHOR_ACCURACY  # anchor never learned
    assert fit.accuracies["judge"] == pytest.approx(0.8, abs=0.08)
    assert fit.accuracies["retried"] == pytest.approx(0.65, abs=0.10)
    assert 0.4 < fit.prior < 0.8
    correct = sum(
        1 for y, r in labeled if (fit.p_success[r.rec_id] >= 0.5) == (y == 1)
    )
    assert correct / len(labeled) > 0.8


def test_dawid_skene_anchor_stays_fixed_under_adversarial_sources():
    rng = random.Random(3)
    rows = []
    for i in range(200):
        y = 1 if rng.random() < 0.5 else 0
        rows.append(
            SourceVotes(
                rec_id=f"r{i}",
                votes={"gate": y, "observer_flagged": 1 - y},  # source that always disagrees
            )
        )
    fit = fit_label_model(rows)
    assert fit.accuracies["gate"] == ANCHOR_ACCURACY
    assert fit.accuracies["observer_flagged"] == 0.5  # clamped floor, not learned below chance


def test_fit_label_model_empty():
    fit = fit_label_model([])
    assert fit.p_success == {}
    assert fit.n_rows == 0


# --------------------------------------------------------------- vote construction


def test_build_votes_gate_and_judge_sources():
    rows = [
        _row("g1", source="gate", outcome="success"),
        _row("g2", source="gate", outcome="failure"),
        _row("j1", source="judge", outcome="partial", quality=0.7),
        _row("j2", source="judge", outcome="failure", quality=0.2),
        _row("u1"),  # unreconciled -> dropped
        _row("n1", source="none", outcome="success"),  # no vote-bearing source -> dropped
    ]
    votes = {v.rec_id: v.votes for v in build_votes(rows)}
    assert votes["g1"] == {"gate": 1}
    assert votes["g2"] == {"gate": 0}
    assert votes["j1"] == {"judge": 1}
    assert votes["j2"] == {"judge": 0}
    assert "u1" not in votes
    assert "n1" not in votes


def test_build_votes_signal_polarity_and_steps():
    rows = [_row("r1", source="none", outcome="success")]
    fs = {
        "r1": FeedbackSignals(
            signals={
                "retried": True,
                "user_corrected": False,
                "session_continued": True,
                "free_form_extra": True,  # non-reserved: no defined polarity, ignored
            },
            steps_all_success=True,
        )
    }
    votes = {v.rec_id: v.votes for v in build_votes(rows, signals_by_rec=fs)}
    assert votes["r1"] == {
        "retried": 0,  # fired negative signal votes failure
        "user_corrected": 1,  # un-fired negative signal votes success
        "session_continued": 1,  # fired positive signal votes success
        "steps": 1,
    }
    assert "free_form_extra" not in votes["r1"]


def test_build_votes_steps_failure_votes_failure():
    rows = [_row("r1", source="none", outcome="success")]
    fs = {"r1": FeedbackSignals(steps_all_success=False)}
    votes = {v.rec_id: v.votes for v in build_votes(rows, signals_by_rec=fs)}
    assert votes["r1"] == {"steps": 0}


# --------------------------------------------------------------- surrogate index (D3)


def _trusted_rows(n_success: int, n_failure: int) -> list[DecisionRecord]:
    rows = []
    for i in range(n_success):
        rows.append(
            _row(
                f"s{i}",
                source="human",
                outcome="success",
                output_tokens=2000 + i,
                latency_ms=1500,
                cost_usd=0.002,
            )
        )
    for i in range(n_failure):
        rows.append(
            _row(
                f"f{i}",
                source="human",
                outcome="failure",
                output_tokens=10 + i,
                latency_ms=200,
                cost_usd=0.0001,
            )
        )
    return rows


def test_surrogate_disabled_below_min_n():
    assert fit_surrogate(_trusted_rows(25, 24)) is None  # 49 < 50


def test_surrogate_learns_and_clamps():
    model = fit_surrogate(_trusted_rows(30, 30))
    assert model is not None
    assert model.n == 60
    lo, hi = SURROGATE_CLAMP
    p_high = surrogate_predict(
        model,
        _row("q1", source="none", outcome="success", output_tokens=2100, latency_ms=1500,
             cost_usd=0.002),
        None,
    )
    p_low = surrogate_predict(
        model,
        _row("q2", source="none", outcome="success", output_tokens=12, latency_ms=200,
             cost_usd=0.0001),
        None,
    )
    assert p_high is not None and p_low is not None
    assert p_high > p_low
    assert lo <= p_low <= hi
    assert lo <= p_high <= hi  # separable data saturates but stays clamped
    assert p_high == hi
    assert p_low == lo


def test_surrogate_abstains_without_features():
    model = fit_surrogate(_trusted_rows(30, 30))
    assert model is not None
    assert surrogate_predict(model, _row("bare"), None) is None


def test_surrogate_abstains_on_gate_rows_in_build_votes():
    rows = _trusted_rows(30, 30)
    gate_row = _row(
        "g1", source="gate", outcome="success", output_tokens=2000, latency_ms=1500,
        cost_usd=0.002,
    )
    none_row = _row(
        "n1", source="none", outcome="success", output_tokens=2000, latency_ms=1500,
        cost_usd=0.002,
    )
    model = fit_surrogate(rows)
    votes = {v.rec_id: v.votes for v in build_votes([gate_row, none_row], surrogate=model)}
    assert votes["g1"] == {"gate": 1}  # no surrogate leakage onto anchor rows
    assert votes["n1"] == {"surrogate": 1}


def test_fit_lane_label_scores_end_to_end():
    rows = _trusted_rows(30, 30)
    rows.append(_row("j1", source="judge", outcome="success", quality=0.9))
    scores = fit_lane_label_scores(rows, surrogate_enabled=True)
    assert scores["j1"] > 0.5
    assert all(0.0 <= p <= 1.0 for p in scores.values())
    assert fit_lane_label_scores([]) == {}


# --------------------------------------------------------------- signal cache + engine


def test_signal_cache_is_bounded_lru():
    cache = SignalCache(capacity=2)
    cache.put("a", FeedbackSignals(signals={"retried": True}))
    cache.put("b", FeedbackSignals())
    cache.put("c", FeedbackSignals())
    assert cache.get("a") is None  # evicted
    assert cache.get("b") is not None
    assert cache.snapshot().keys() == {"b", "c"}


def _engine(settings: Settings, decision_log: MemoryDecisionLog | None = None) -> Recommender:
    return Recommender(
        settings,
        FakeMemory(),
        CatalogStore(settings),
        RecommendationStore(),
        decision_log=decision_log,
    )


def test_engine_label_scores_flag_off_is_inert():
    settings = Settings(mubit_api_key="t")
    assert settings.minima_label_model is False
    assert settings.minima_surrogate_index is False
    engine = _engine(settings, MemoryDecisionLog())
    assert engine._get_label_scores("minima:default") is None
    engine.record_feedback_signals(
        "r1", signals={"retried": True}, steps_all_success=None, iterations=None
    )
    assert engine._signal_cache.snapshot() == {}


def test_engine_label_scores_flag_on_fits_and_caches():
    settings = Settings(mubit_api_key="t", minima_label_model=True)
    log = MemoryDecisionLog()
    row = _row("r1", source="judge", outcome="success", quality=0.9)
    log.put(row)
    log_row = log.get("r1")
    assert log_row is not None and log_row.reconciled
    engine = _engine(settings, log)
    engine.record_feedback_signals(
        "r1", signals={"session_continued": True}, steps_all_success=True, iterations=2
    )
    assert engine._signal_cache.get("r1") is not None
    scores = engine._get_label_scores("minima:default")
    assert scores is not None and scores["r1"] > 0.5
    # Cached: mutating the log does not change the scores until the refresh window laps.
    log.put(_row("r2", source="judge", outcome="failure", quality=0.1))
    assert engine._get_label_scores("minima:default") is scores
