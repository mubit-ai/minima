"""Phase A tests: RoutingResult explainability, CostMeter, before_route hook."""

from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from minima.schemas.common import DecisionBasis, Difficulty, TaskType
from minima.schemas.recommend import RankedModel, RecommendResponse
from minima_harness.ai import AssistantMessage, TextContent, get_model
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.types import Usage
from minima_harness.minima import (
    CostMeter,
    HarnessConfig,
    MinimaAgent,
    MinimaRouter,
    Ranking,
    RoutingResult,
)
from minima_harness.minima.judge import DeterministicJudge


def _ranked(model_id: str, cost: float, success: float = 0.9) -> RankedModel:
    return RankedModel(
        model_id=model_id,
        provider="anthropic",
        predicted_success=success,
        est_cost_usd=cost,
        score=success,
        rationale=f"why-{model_id}",
    )


def _fake_minima_client(ranked_models: list[RankedModel]) -> object:
    rec = RecommendResponse(
        recommendation_id="rec-1",
        recommended_model=ranked_models[0],
        ranked=ranked_models,
        fallback_model=ranked_models[1] if len(ranked_models) > 1 else None,
        confidence=0.82,
        decision_basis=DecisionBasis.memory,
        threshold_used=0.7,
        classified_task_type=TaskType.code,
        classified_difficulty=Difficulty.medium,
        catalog_version="v1",
        warnings=["cold_start"],
    )

    class _Client:
        async def recommend(self, *a, **k):
            return rec

        async def feedback(self, *a, **k):
            return None

    return _Client()


# --------------------------------------------------------------------------- A1


def test_router_maps_full_recommend_response():
    ranked_models = [_ranked("claude-haiku-4-5", 0.001), _ranked("claude-opus-4-8", 0.05)]
    config = HarnessConfig(
        candidates=["claude-haiku-4-5", "claude-opus-4-8"], baseline_model_id="claude-opus-4-8"
    )
    router = MinimaRouter(_fake_minima_client(ranked_models), config)  # type: ignore[arg-type]
    result = asyncio.run(router.recommend("refactor foo", task_type="code"))

    assert result.recommendation_id == "rec-1"
    assert result.chosen_model_id == "claude-haiku-4-5"
    assert result.decision_basis == "memory"
    assert result.confidence == 0.82
    assert result.threshold_used == 0.7
    assert result.fallback_model_id == "claude-opus-4-8"
    assert result.warnings == ["cold_start"]
    assert result.rationale == "why-claude-haiku-4-5"
    assert len(result.ranked) == 2
    assert isinstance(result.ranked[0], Ranking)
    assert result.ranked[1].model_id == "claude-opus-4-8"
    # baseline cost resolved from the ranked set (no Minima round-trip needed)
    assert result.baseline_cost_usd == 0.05


def test_baseline_cost_none_without_baseline_id():
    ranked_models = [_ranked("claude-haiku-4-5", 0.001)]
    config = HarnessConfig(candidates=["claude-haiku-4-5"])  # no baseline_model_id
    router = MinimaRouter(_fake_minima_client(ranked_models), config)  # type: ignore[arg-type]
    result = asyncio.run(router.recommend("task"))
    assert result.baseline_cost_usd is None


# --------------------------------------------------------------------------- A2


def _routing(est=0.001, baseline=0.05) -> RoutingResult:
    return RoutingResult(
        recommendation_id="rec-1",
        chosen_model_id="claude-haiku-4-5",
        model=get_model("anthropic", "claude-haiku-4-5"),
        est_cost_usd=est,
        decision_basis="memory",
        baseline_cost_usd=baseline,
    )


def test_cost_meter_record_and_totals():
    meter = CostMeter()
    meter.record(
        label="t1",
        routing=_routing(est=0.001, baseline=0.01),
        actual_cost_usd=0.002,
        quality=0.95,
        outcome="success",
    )
    meter.record(
        label="t2",
        routing=_routing(est=0.002, baseline=0.02),
        actual_cost_usd=0.005,
        quality=0.2,
        outcome="failure",
    )
    meter.record(
        label="t3", routing=None, actual_cost_usd=0.001, quality=None, outcome="success"
    )  # offline, no baseline

    t = meter.totals()
    assert t.n == 3
    assert t.actual_cost_usd == pytest.approx(0.008)
    assert t.baseline_cost_usd == pytest.approx(0.03)  # only the 2 with baselines
    assert t.baseline_rows == 2
    assert t.successes == 2
    assert t.savings_usd == pytest.approx(0.03 - 0.008)
    assert t.savings_pct == pytest.approx(100.0 * (0.03 - 0.008) / 0.03)
    assert t.success_rate == pytest.approx(100.0 * 2 / 3)


def test_cost_meter_report_rends_table_and_summary():
    meter = CostMeter()
    meter.record(
        label="t1",
        routing=_routing(est=0.001, baseline=0.01),
        actual_cost_usd=0.002,
        quality=0.9,
        outcome="success",
    )
    report = meter.report()
    assert "label" in report and "actual$" in report and "save$" in report
    assert "savings" in report.lower()
    assert "success" in report.lower()


# --------------------------------------------------------------------------- A3


class _FakeRouter:
    def __init__(self, model, baseline=0.05):
        self.model = model
        self.baseline = baseline
        self.feedback_calls: list[dict] = []
        from minima_harness.minima import ModelMapping

        self.mapping = ModelMapping()

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
        return RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id="claude-haiku-4-5",
            model=self.model,
            est_cost_usd=0.001,
            decision_basis="memory",
            baseline_cost_usd=self.baseline,
        )

    async def feedback(
        self, rec_id, chosen, outcome, *, quality, usage, latency_ms, iterations=None
    ):
        self.feedback_calls.append(
            {"rec_id": rec_id, "chosen": chosen, "outcome": outcome, "quality": quality}
        )


def _text_msg(text, usage_out=5):
    m = AssistantMessage(content=[TextContent(text=text)])
    m.usage = Usage(input=10, output=usage_out)
    return m


def _agent(router, **kw):
    return MinimaAgent(
        HarnessConfig(candidates=["claude-haiku-4-5"], judge_every=1),
        router=router,
        judge=DeterministicJudge(lambda t: 0.95),
        model=get_model("anthropic", "claude-haiku-4-5"),
        **kw,
    )


def test_before_route_none_accepts_recommendation():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        router = _FakeRouter(reg.get_model())

        async def accept(r, t):
            return None

        agent = _agent(router, before_route=accept)
        asyncio.run(agent.prompt("hi"))
    assert router.feedback_calls[0]["chosen"] == "claude-haiku-4-5"


def test_before_route_override_changes_feedback_model():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        router = _FakeRouter(reg.get_model())

        async def force(r, t):
            return replace(r, chosen_model_id="forced-by-hook")

        agent = _agent(router, before_route=force)
        asyncio.run(agent.prompt("hi"))
    assert router.feedback_calls[0]["chosen"] == "forced-by-hook"


def test_before_route_veto_skips_feedback():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        router = _FakeRouter(reg.get_model())

        async def veto(r, t):
            # recommendation_id=None -> run proceeds but no feedback is attributed
            return replace(r, recommendation_id=None, chosen_model_id="vetoed-model")

        agent = _agent(router, before_route=veto)
        asyncio.run(agent.prompt("hi"))
    assert router.feedback_calls == []  # vetoed -> no feedback
    assert agent.state.messages[-1].text == "ans"  # run still happened


def test_meter_records_after_prompt():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans", usage_out=5)])
        meter = CostMeter()
        router = _FakeRouter(reg.get_model(), baseline=0.05)
        agent = _agent(router, meter=meter)
        asyncio.run(agent.prompt("do the thing"))
    assert len(meter.rows) == 1
    row = meter.rows[0]
    assert row.model == "claude-haiku-4-5"
    assert row.outcome == "success"
    assert row.quality == 0.95
    assert row.baseline_cost_usd == 0.05
    # The faux model is free (ModelCost 0/0), so realized cost is 0; the baseline
    # still counts, so savings == baseline.
    assert row.actual_cost_usd == 0.0
    t = meter.totals()
    assert t.savings_usd == pytest.approx(0.05)
