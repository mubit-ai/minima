"""Phase C (harness): turns_taken is tracked, flows to feedback(iterations=), and the
meter surfaces it. The token-yield signal: a multi-turn tool run counts more turns than
a one-shot answer."""

from __future__ import annotations

import asyncio

from pydantic import BaseModel

from minima_harness.agent import AgentTool, ToolResult
from minima_harness.ai import AssistantMessage, TextContent, ToolCall
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.types import Usage
from minima_harness.minima import CostMeter, HarnessConfig, MinimaAgent
from minima_harness.minima.judge import DeterministicJudge
from minima_harness.minima.router import RoutingResult


class _Router:
    def __init__(self, model):
        self.model = model
        self.feedback_calls: list[dict] = []
        from minima_harness.minima import ModelMapping

        self.mapping = ModelMapping()

    async def recommend(self, task, **kw):
        return RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id="claude-haiku-4-5",
            model=self.model,
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(
        self, rec_id, chosen, outcome, *, quality, usage, latency_ms, iterations=None
    ):
        self.feedback_calls.append({"chosen": chosen, "iterations": iterations})


def _text(text):
    m = AssistantMessage(content=[TextContent(text=text)])
    m.usage = Usage(input=5, output=5)
    return m


def _agent(router, *, tools=None, meter=None):
    return MinimaAgent(
        HarnessConfig(candidates=["claude-haiku-4-5"], judge_every=1),
        router=router,
        judge=DeterministicJudge(lambda t: 0.9),
        model=router.model,
        tools=tools or [],
        meter=meter,
    )


def test_single_turn_answer_counts_one_turn():
    with register_faux_provider() as reg:
        reg.set_responses([_text("done")])
        router = _Router(reg.get_model())
        agent = _agent(router)
        asyncio.run(agent.prompt("hi"))
    assert agent.state.turns_taken == 1
    assert router.feedback_calls[0]["iterations"] == 1


def test_tool_run_counts_two_turns():
    class Empty(BaseModel):
        pass

    async def echo(_id, _p, _s, _u):
        return ToolResult(content=[TextContent(text="ok")])

    tool = AgentTool(name="echo", description="d", parameters=Empty, execute=echo)
    with register_faux_provider() as reg:
        reg.set_responses(
            [
                AssistantMessage(
                    content=[ToolCall(id="t1", name="echo", arguments={})], stop_reason="toolUse"
                ),
                _text("final"),
            ]
        )
        router = _Router(reg.get_model())
        agent = _agent(router, tools=[tool])
        asyncio.run(agent.prompt("call echo"))
    assert agent.state.turns_taken == 2
    assert router.feedback_calls[0]["iterations"] == 2


def test_meter_records_turns():
    with register_faux_provider() as reg:
        reg.set_responses([_text("done")])
        router = _Router(reg.get_model())
        meter = CostMeter()
        agent = _agent(router, meter=meter)
        asyncio.run(agent.prompt("hi"))
    assert meter.rows[0].turns == 1
    assert "turns" in meter.report()
