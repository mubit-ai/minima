"""MinimaAgent <-> Mubit memory integration (hermetic, via a FakeMemory).

Covers the two halves the audit found missing from the harness: recall-before-route
(prior context injected into the turn's system prompt, then restored) and write-back
after feedback (outcome recorded, attributed to the recommendation, never fabricated).
"""

from __future__ import annotations

import asyncio

from minima_harness.ai import AssistantMessage, TextContent
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.types import Usage
from minima_harness.minima import HarnessConfig, MinimaAgent, ModelMapping, RoutingResult
from minima_harness.minima.judge import DeterministicJudge
from minima_harness.minima.memory import NoopHarnessMemory


class FakeRouter:
    def __init__(self, model, *, fail_recommend=False):
        self.model = model
        self.mapping = ModelMapping()
        self.feedback_calls: list[dict] = []
        self._fail = fail_recommend

    async def aclose(self) -> None:
        pass

    async def recommend(self, task, *, task_type=None, slider=None, tags=None, **_):
        if self._fail:
            raise RuntimeError("minima unreachable")
        return RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id="faux",
            model=self.model,
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(
        self, rec_id, chosen, outcome, *, quality, usage, latency_ms, iterations=None
    ):
        self.feedback_calls.append({"rec_id": rec_id, "outcome": outcome, "quality": quality})


class FakeMemory:
    """Records every call so tests can assert recall-before-route + write-back."""

    def __init__(self, snippets: list[str] | None = None) -> None:
        self._snippets = snippets or []
        self.recall_calls: list[str] = []
        self.outcome_calls: list[dict] = []
        self.end_calls = 0

    async def recall(self, task, *, limit=5):
        self.recall_calls.append(task)
        return list(self._snippets)

    async def record_outcome(
        self, *, task, recommendation_id, model_id, outcome, quality, cost_usd, latency_ms, turns
    ):
        self.outcome_calls.append(
            {
                "task": task,
                "recommendation_id": recommendation_id,
                "model_id": model_id,
                "outcome": outcome,
                "quality": quality,
                "cost_usd": cost_usd,
                "latency_ms": latency_ms,
                "turns": turns,
            }
        )

    async def end_session(self):
        self.end_calls += 1


def _text_msg(text, usage_in=10, usage_out=5):
    m = AssistantMessage(content=[TextContent(text=text)])
    m.usage = Usage(input=usage_in, output=usage_out)
    return m


def test_recall_injected_into_system_prompt_then_restored():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux = reg.get_model()
        mem = FakeMemory(snippets=["prefer an expert model for GraphQL resolvers"])
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=FakeRouter(faux),
            model=faux,
            system_prompt="BASE",
            memory=mem,
        )
        seen: dict[str, str | None] = {}

        async def capture(routing, task):
            # before_route fires after recall has augmented the prompt, before the model runs.
            seen["system"] = agent.state.system_prompt
            return None

        agent.before_route = capture
        asyncio.run(agent.prompt("build a GraphQL resolver"))

    assert mem.recall_calls == ["build a GraphQL resolver"]  # recall happened, with the task
    assert "prefer an expert model for GraphQL resolvers" in (seen["system"] or "")  # injected
    assert "BASE" in (seen["system"] or "")  # layered on top of the base prompt
    assert agent.state.system_prompt == "BASE"  # …and restored afterwards (no leak)


def test_no_recall_leaves_system_prompt_untouched():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux = reg.get_model()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=FakeRouter(faux),
            model=faux,
            system_prompt="BASE",
            memory=FakeMemory(snippets=[]),  # nothing to recall
        )
        asyncio.run(agent.prompt("hi"))
    assert agent.state.system_prompt == "BASE"


def test_outcome_written_back_with_attribution():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans", usage_out=7)])
        faux = reg.get_model()
        mem = FakeMemory()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=FakeRouter(faux),
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux,
            memory=mem,
        )
        asyncio.run(agent.prompt("do x"))
    assert len(mem.outcome_calls) == 1
    c = mem.outcome_calls[0]
    assert c["recommendation_id"] == "rec-1"  # attributed to the recommendation
    assert c["model_id"] == "faux"
    assert c["outcome"] == "success"
    assert c["quality"] == 0.9
    assert c["turns"] >= 1
    assert c["cost_usd"] >= 0.0


def test_abstain_passes_quality_none_no_fabrication():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux = reg.get_model()
        mem = FakeMemory()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),  # judging off -> abstain
            router=FakeRouter(faux),
            model=faux,
            memory=mem,
        )
        asyncio.run(agent.prompt("do x"))
    assert mem.outcome_calls[0]["quality"] is None  # the agent never invents a score


def test_offline_route_writes_no_outcome():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux = reg.get_model()
        mem = FakeMemory(snippets=["x"])
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1, allow_offline=True),
            router=FakeRouter(faux, fail_recommend=True),  # no recommendation_id
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux,
            memory=mem,
        )
        asyncio.run(agent.prompt("hi"))
    assert mem.recall_calls == ["hi"]  # recall still runs (helps even offline)
    assert mem.outcome_calls == []  # …but no recommendation -> nothing to attribute a score to


def test_default_memory_is_noop():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux = reg.get_model()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=FakeRouter(faux),
            model=faux,
        )
        assert isinstance(agent.memory, NoopHarnessMemory)
        asyncio.run(agent.prompt("hi"))  # runs cleanly with the no-op default


def test_end_session_delegates_to_memory():
    mem = FakeMemory()
    with register_faux_provider() as reg:
        faux = reg.get_model()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"]), router=FakeRouter(faux), model=faux, memory=mem
        )
        asyncio.run(agent.end_session())
    assert mem.end_calls == 1
