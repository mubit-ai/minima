"""Hermetic tests for the judges."""

from __future__ import annotations

import asyncio

from minima_harness.ai import AssistantMessage, TextContent
from minima_harness.ai.providers import register_faux_provider
from minima_harness.minima.judge import (
    ConstJudge,
    DeterministicJudge,
    LLMJudge,
    _parse_score,
)


def test_parse_score_extracts_0_10_int():
    assert _parse_score("8") == 8.0
    assert _parse_score("Grade: 9\n") == 9.0
    assert _parse_score("0") == 0.0
    assert _parse_score("I'd rate this 8/10.") == 8.0
    assert _parse_score("There were 3 issues, score 7") == 7.0  # keyword beats the stray int


def test_parse_score_returns_none_when_no_valid_score():
    # No fabricated neutral 0.5 anymore: unparseable -> None (abstain).
    assert _parse_score("no digits here") is None
    assert _parse_score("99 balloons") is None  # out of 0-10 -> abstain


def test_deterministic_judge_wraps_fn_and_clamps():
    assert asyncio.run(DeterministicJudge(lambda t: 0.9).grade("task", "out")) == 0.9
    assert asyncio.run(DeterministicJudge(lambda t: 1.5).grade("task", "out")) == 1.0
    assert asyncio.run(DeterministicJudge(lambda t: -0.2).grade("task", "out")) == 0.0


def test_deterministic_judge_broken_fn_abstains():
    def boom(_t: str) -> float:
        raise RuntimeError("bad scorer")

    # A broken scorer must ABSTAIN (None), not record a fabricated 0.0 failure.
    assert asyncio.run(DeterministicJudge(boom).grade("task", "out")) is None


def test_const_judge():
    assert asyncio.run(ConstJudge(0.7).grade("task", "out")) == 0.7
    assert asyncio.run(ConstJudge(1.4).grade("task", "out")) == 1.0  # clamped
    assert asyncio.run(ConstJudge(None).grade("task", "out")) is None  # abstain


def test_llm_judge_parses_score_from_model():
    with register_faux_provider() as reg:
        reg.set_responses([AssistantMessage(content=[TextContent(text="8")])])
        judge = LLMJudge(reg.get_model())
        assert asyncio.run(judge.grade("task", "output")) == 0.8


def test_llm_judge_unparseable_response_abstains():
    with register_faux_provider() as reg:
        reg.set_responses([AssistantMessage(content=[TextContent(text="no number")])])
        judge = LLMJudge(reg.get_model())
        assert asyncio.run(judge.grade("task", "output")) is None
