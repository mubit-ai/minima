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


def test_parse_score_picks_first_int_in_range():
    assert _parse_score("8") == 8.0
    assert _parse_score("Grade: 9\n") == 9.0
    assert _parse_score("0") == 0.0
    assert _parse_score("no digits here") == 5.0
    assert _parse_score("99 balloons") == 5.0  # out of 0-10 -> neutral


def test_deterministic_judge_wraps_fn_and_clamps():
    assert asyncio.run(DeterministicJudge(lambda t: 0.9).grade("task", "out")) == 0.9
    assert asyncio.run(DeterministicJudge(lambda t: 1.5).grade("task", "out")) == 1.0
    assert asyncio.run(DeterministicJudge(lambda t: -0.2).grade("task", "out")) == 0.0


def test_deterministic_judge_broken_fn_returns_zero():
    def boom(_t: str) -> float:
        raise RuntimeError("bad scorer")

    assert asyncio.run(DeterministicJudge(boom).grade("task", "out")) == 0.0


def test_const_judge():
    assert asyncio.run(ConstJudge(0.7).grade("task", "out")) == 0.7
    assert asyncio.run(ConstJudge(1.4).grade("task", "out")) == 1.0  # clamped


def test_llm_judge_parses_score_from_model():
    with register_faux_provider() as reg:
        reg.set_responses([AssistantMessage(content=[TextContent(text="8")])])
        judge = LLMJudge(reg.get_model())
        assert asyncio.run(judge.grade("task", "output")) == 0.8


def test_llm_judge_unparseable_response_is_neutral():
    with register_faux_provider() as reg:
        reg.set_responses([AssistantMessage(content=[TextContent(text="no number")])])
        judge = LLMJudge(reg.get_model())
        assert asyncio.run(judge.grade("task", "output")) == 0.5
