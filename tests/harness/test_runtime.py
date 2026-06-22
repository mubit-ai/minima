"""Hermetic tests for MinimaAgent orchestration via a FakeRouter + faux provider.

Verifies the route->set model->run->judge->feedback loop without a real Minima or LLM:
routing is called with the task text, the model is set, the run streams via faux, and
feedback carries the right outcome/quality/tokens/cost/latency. Also covers offline
fallback, judge cadence, and a multi-turn tool run.
"""

from __future__ import annotations

import asyncio

from pydantic import BaseModel

from minima_harness.agent import AgentTool, ToolResult
from minima_harness.ai import AssistantMessage, TextContent, ToolCall
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.types import Usage
from minima_harness.minima import HarnessConfig, MinimaAgent, ModelMapping, RoutingResult
from minima_harness.minima.judge import DeterministicJudge


class FakeRouter:
    def __init__(self, model, *, recommend_model_id="faux", fail_recommend=False):
        self.model = model
        self.mapping = ModelMapping()
        self.recommend_calls: list[dict] = []
        self.feedback_calls: list[dict] = []
        self._fail = fail_recommend
        self._recommend_model_id = recommend_model_id

    async def recommend(
        self,
        task,
        *,
        task_type=None,
        slider=None,
        tags=None,
        difficulty=None,
        expected_input_tokens=None,
    ):
        self.recommend_calls.append({"task": task, "task_type": task_type, "slider": slider})
        if self._fail:
            raise RuntimeError("minima unreachable")
        return RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id=self._recommend_model_id,
            model=self.model,
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(
        self, rec_id, chosen, outcome, *, quality, usage, latency_ms, iterations=None
    ):
        self.feedback_calls.append(
            {
                "rec_id": rec_id,
                "chosen": chosen,
                "outcome": outcome,
                "quality": quality,
                "input_tokens": usage.input,
                "output_tokens": usage.output,
                "cost": usage.cost.total,
                "latency_ms": latency_ms,
            }
        )


def _text_msg(text, usage_in=10, usage_out=5):
    m = AssistantMessage(content=[TextContent(text=text)])
    m.usage = Usage(input=usage_in, output=usage_out)
    return m


def test_routes_sets_model_and_feeds_back():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("the answer")])
        faux_model = reg.get_model()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=FakeRouter(faux_model),
            judge=DeterministicJudge(lambda t: 0.95),
            model=faux_model,
            task_type="qa",
        )
        asyncio.run(agent.prompt("what is x?", task_type="reasoning"))

    assert agent.state.model is faux_model
    rc = agent.router.recommend_calls[0]  # type: ignore[attr-defined]
    assert rc["task"] == "what is x?"
    assert rc["task_type"] == "reasoning"  # per-prompt overrides the hint
    fb = agent.router.feedback_calls[0]  # type: ignore[attr-defined]
    assert fb["rec_id"] == "rec-1"
    assert fb["outcome"] == "success"
    assert fb["quality"] == 0.95
    assert fb["input_tokens"] == 10
    assert fb["output_tokens"] == 5
    assert fb["cost"] >= 0.0
    assert fb["latency_ms"] >= 0


def test_judge_every_zero_sends_neutral_quality():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=router,
            judge=DeterministicJudge(lambda t: 0.99),
            model=faux_model,
        )
        asyncio.run(agent.prompt("hi"))
    fb = router.feedback_calls[0]
    assert fb["quality"] is None  # not judged
    assert fb["outcome"] == "success"  # neutral


def test_low_quality_maps_to_failure():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("bad")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.1),
            model=faux_model,
        )
        asyncio.run(agent.prompt("hi"))
    assert router.feedback_calls[0]["outcome"] == "failure"


def test_offline_fallback_runs_without_feedback():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model, fail_recommend=True)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1, allow_offline=True),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux_model,  # stays the working model when routing fails
        )
        asyncio.run(agent.prompt("hi"))
    assert router.recommend_calls  # routing was attempted
    assert router.feedback_calls == []  # no rec id -> no feedback
    assert agent.state.messages[-1].text == "ans"  # run still happened


def test_offline_fallback_raises_when_disallowed():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model, fail_recommend=True)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], allow_offline=False),
            router=router,
            model=faux_model,
        )
        import pytest

        with pytest.raises(RuntimeError, match="minima unreachable"):
            asyncio.run(agent.prompt("hi"))


def test_multi_turn_tool_run_judges_final_answer():
    class Empty(BaseModel):
        pass

    async def echo(tool_call_id, params, signal, on_update):
        return ToolResult(content=[TextContent(text="tool-said-hi")])

    tool = AgentTool(name="echo", description="d", parameters=Empty, execute=echo)
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                AssistantMessage(
                    content=[ToolCall(id="t1", name="echo", arguments={})], stop_reason="toolUse"
                ),
                _text_msg("final answer is good", usage_out=20),
            ]
        )
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.85),
            model=faux_model,
            tools=[tool],
        )
        asyncio.run(agent.prompt("call echo then answer"))
    fb = router.feedback_calls[0]
    assert fb["outcome"] == "success"
    assert fb["quality"] == 0.85
    assert fb["output_tokens"] == 20  # from the FINAL assistant message
