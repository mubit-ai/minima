"""Unit tests for MubitHarnessMemory (the Mubit-SDK-backed HarnessMemory), with the SDK
monkeypatched. Asserts the correctness properties that matter: attribution via
recommendation_id, NO fabricated score on judge abstention, snippet extraction/caps,
reflect+checkpoint on session end, availability gating, and fail-open behavior.
"""

from __future__ import annotations

import asyncio
import sys

import pytest

from minima_harness.minima.memory import (
    MubitHarnessMemory,
    NoopHarnessMemory,
    format_recall_block,
)


class _FakeMubit:
    def __init__(self) -> None:
        self.remember_calls: list[dict] = []
        self.outcome_calls: list[dict] = []
        self.reflect_calls: list[str | None] = []
        self.checkpoint_calls: list[tuple[str, str | None]] = []
        self.recall_return: list = []

    def recall(self, query, *, session_id=None, limit=5, entry_types=None):
        return self.recall_return

    def remember(self, content, *, intent="", session_id=None, agent_id=None, **kw):
        self.remember_calls.append(
            {"content": content, "intent": intent, "session_id": session_id, **kw}
        )

    def outcome(self, score, *, outcome_label="", reference_id="global", session_id=None, **kw):
        self.outcome_calls.append(
            {"score": score, "outcome_label": outcome_label, "reference_id": reference_id}
        )

    def reflect(self, *, session_id=None, **kw):
        self.reflect_calls.append(session_id)

    def checkpoint(self, *, label="", session_id=None, **kw):
        self.checkpoint_calls.append((label, session_id))


@pytest.fixture
def fake_mubit(monkeypatch):
    fm = _FakeMubit()
    monkeypatch.setitem(sys.modules, "mubit", fm)
    monkeypatch.setattr("minima_harness.tui.mubit.available", lambda: True)
    return fm


def test_record_outcome_writes_trace_and_score(fake_mubit):
    m = MubitHarnessMemory(session_id="s1")
    asyncio.run(
        m.record_outcome(
            task="build a GraphQL resolver",
            recommendation_id="rec-9",
            model_id="haiku",
            outcome="success",
            quality=0.87,
            cost_usd=0.0012,
            latency_ms=1200,
            turns=2,
        )
    )
    assert len(fake_mubit.remember_calls) == 1
    r = fake_mubit.remember_calls[0]
    assert r["intent"] == "trace"
    assert r["session_id"] == "s1"
    assert r["idempotency_key"] == "rec-9"  # attributed to the recommendation
    assert "haiku" in r["content"] and "success" in r["content"]
    assert len(fake_mubit.outcome_calls) == 1
    o = fake_mubit.outcome_calls[0]
    assert o["score"] == 0.87
    assert o["reference_id"] == "rec-9"
    assert o["outcome_label"] == "success"


def test_record_outcome_abstain_writes_trace_but_no_score(fake_mubit):
    m = MubitHarnessMemory(session_id="s1")
    asyncio.run(
        m.record_outcome(
            task="x",
            recommendation_id="rec-1",
            model_id="m",
            outcome="success",
            quality=None,  # judge abstained
            cost_usd=0.0,
            latency_ms=0,
            turns=1,
        )
    )
    assert len(fake_mubit.remember_calls) == 1  # the trace is still recorded
    assert fake_mubit.outcome_calls == []  # …but NO fabricated score is written


def test_record_outcome_noop_without_recommendation_id(fake_mubit):
    m = MubitHarnessMemory(session_id="s1")
    asyncio.run(
        m.record_outcome(
            task="x", recommendation_id="", model_id="m", outcome="success",
            quality=0.9, cost_usd=0.0, latency_ms=0, turns=1,
        )
    )
    assert fake_mubit.remember_calls == [] and fake_mubit.outcome_calls == []


def test_recall_extracts_snippets_and_caps(fake_mubit):
    class _Entry:
        def __init__(self, content):
            self.content = content

    fake_mubit.recall_return = [
        {"content": "lesson A"},
        _Entry("lesson B"),
        {"nope": 1},  # junk with no text -> skipped
        "lesson D",
        "lesson E",
    ]
    m = MubitHarnessMemory(session_id="s1")
    out = asyncio.run(m.recall("q", limit=3))
    assert out == ["lesson A", "lesson B", "lesson D"]  # dict/obj/str handled, junk skipped, capped


def test_recall_empty_task_or_unavailable(monkeypatch, fake_mubit):
    m = MubitHarnessMemory(session_id="s1")
    assert asyncio.run(m.recall("   ")) == []  # blank task short-circuits
    monkeypatch.setattr("minima_harness.tui.mubit.available", lambda: False)
    fake_mubit.recall_return = [{"content": "x"}]
    assert asyncio.run(m.recall("q")) == []  # not ready -> no recall


def test_end_session_reflects_and_checkpoints(fake_mubit):
    m = MubitHarnessMemory(session_id="s7")
    asyncio.run(m.end_session())
    assert fake_mubit.reflect_calls == ["s7"]
    assert fake_mubit.checkpoint_calls == [("session-end", "s7")]


def test_fail_open_on_sdk_error(fake_mubit, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("mubit down")

    monkeypatch.setattr(fake_mubit, "recall", boom)
    monkeypatch.setattr(fake_mubit, "remember", boom)
    m = MubitHarnessMemory(session_id="s1")
    assert asyncio.run(m.recall("q")) == []  # swallowed -> empty
    # record_outcome must not raise even if the SDK explodes
    asyncio.run(
        m.record_outcome(
            task="x", recommendation_id="r", model_id="m", outcome="success",
            quality=0.9, cost_usd=0.0, latency_ms=0, turns=1,
        )
    )


def test_noop_memory_is_inert():
    m = NoopHarnessMemory()
    assert asyncio.run(m.recall("q")) == []
    asyncio.run(
        m.record_outcome(
            task="x", recommendation_id="r", model_id="m", outcome="success",
            quality=0.9, cost_usd=0.0, latency_ms=0, turns=1,
        )
    )
    asyncio.run(m.end_session())


def test_format_recall_block():
    block = format_recall_block(["alpha", "beta"])
    assert "prior_learnings" in block
    assert "- alpha" in block and "- beta" in block
