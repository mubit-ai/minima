"""Adapters exercised against the REAL installed frameworks (skip when absent).

Run with the frameworks present: ``uv pip install litellm openhands-sdk`` (or the
``adapters`` extra). Minima itself is stubbed — these tests pin OUR glue against
the frameworks' true interfaces, which is exactly the part that can drift.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import pytest


@dataclass
class _RankedStub:
    model_id: str
    est_cost_usd: float = 0.001
    predicted_success: float = 0.9


@dataclass
class _RecStub:
    recommendation_id: str
    recommended_model: _RankedStub
    warnings: list[str] = field(default_factory=list)


class _MinimaStub:
    def __init__(self, pick: str):
        self.pick = pick
        self.recommend_calls: list[dict] = []
        self.feedback_calls: list[dict] = []

    def recommend(self, task, **kwargs):
        self.recommend_calls.append({"task": task, **kwargs})
        return _RecStub("rec-1", _RankedStub(self.pick))

    def feedback(self, rec_id, model, outcome, **kwargs):
        self.feedback_calls.append(
            {"rec_id": rec_id, "model": model, "outcome": outcome, **kwargs}
        )
        return type("R", (), {"accepted": True, "warnings": []})()


# ---------------------------------------------------------------- LiteLLM ----


def _litellm_router():
    litellm = pytest.importorskip("litellm")
    return litellm.Router(
        model_list=[
            {
                "model_name": "my-group",
                "litellm_params": {"model": "anthropic/claude-haiku-4-5", "api_key": "x"},
            },
            {
                "model_name": "my-group",
                "litellm_params": {"model": "anthropic/claude-sonnet-4-6", "api_key": "x"},
            },
        ]
    )


def test_litellm_strategy_picks_minima_recommendation():
    router = _litellm_router()
    from minima_client.integrations.litellm_router import MinimaRoutingStrategy

    minima = _MinimaStub(pick="claude-sonnet-4-6")
    strategy = MinimaRoutingStrategy(minima, router)
    router.set_custom_routing_strategy(strategy)

    messages = [{"role": "user", "content": "prove this theorem"}]
    deployment = asyncio.run(
        strategy.async_get_available_deployment("my-group", messages=messages)
    )
    assert deployment is not None
    assert deployment["litellm_params"]["model"] == "anthropic/claude-sonnet-4-6"
    # Candidates were the bare catalog ids, sorted.
    assert minima.recommend_calls[0]["constraints"]["candidate_models"] == [
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
    ]


def test_litellm_strategy_fails_open_when_minima_is_down():
    router = _litellm_router()
    from minima_client.integrations.litellm_router import MinimaRoutingStrategy

    class _Down:
        def recommend(self, *a, **k):
            raise RuntimeError("unreachable")

    strategy = MinimaRoutingStrategy(_Down(), router)
    deployment = strategy.get_available_deployment(
        "my-group", messages=[{"role": "user", "content": "hi"}]
    )
    assert deployment is None  # None => LiteLLM falls back to its default strategy


def test_litellm_logger_reports_realized_cost_as_telemetry():
    router = _litellm_router()
    from minima_client.integrations.litellm_router import (
        MinimaFeedbackLogger,
        MinimaRoutingStrategy,
    )

    minima = _MinimaStub(pick="claude-haiku-4-5")
    strategy = MinimaRoutingStrategy(minima, router)
    messages = [{"role": "user", "content": "summarize"}]
    asyncio.run(strategy.async_get_available_deployment("my-group", messages=messages))

    logger = MinimaFeedbackLogger(minima, strategy)
    usage = type("U", (), {"prompt_tokens": 120, "completion_tokens": 40})()
    response = type("Resp", (), {"usage": usage})()
    start, end = datetime(2026, 1, 1), datetime(2026, 1, 1) + timedelta(seconds=2)
    asyncio.run(
        logger.async_log_success_event(
            {"model": "my-group", "messages": messages, "response_cost": 0.0007},
            response,
            start,
            end,
        )
    )
    fb = minima.feedback_calls[0]
    assert fb["rec_id"] == "rec-1"
    assert fb["model"] == "claude-haiku-4-5"
    assert fb["actual_cost_usd"] == pytest.approx(0.0007)
    assert fb["evidence_source"] == "none"  # no grader => telemetry, never a label
    assert fb["latency_ms"] == 2000
    # The correlation entry is consumed — a second event can't double-report.
    asyncio.run(
        logger.async_log_success_event(
            {"model": "my-group", "messages": messages, "response_cost": 0.0007},
            response,
            start,
            end,
        )
    )
    assert len(minima.feedback_calls) == 1


def test_litellm_logger_grades_outcomes_by_threshold():
    router = _litellm_router()
    from minima_client.integrations.litellm_router import (
        MinimaFeedbackLogger,
        MinimaRoutingStrategy,
    )

    start, end = datetime(2026, 1, 1), datetime(2026, 1, 1) + timedelta(seconds=1)
    for quality, outcome, error_cause in [
        (0.9, "success", None),
        (0.5, "partial", None),
        (0.1, "failure", "quality"),
    ]:
        minima = _MinimaStub(pick="claude-haiku-4-5")
        strategy = MinimaRoutingStrategy(minima, router)
        messages = [{"role": "user", "content": f"grade me {quality}"}]
        asyncio.run(strategy.async_get_available_deployment("my-group", messages=messages))
        logger = MinimaFeedbackLogger(minima, strategy, quality_fn=lambda _r, q=quality: q)
        response = type("Resp", (), {"usage": None})()
        asyncio.run(
            logger.async_log_success_event(
                {"model": "my-group", "messages": messages}, response, start, end
            )
        )
        fb = minima.feedback_calls[0]
        assert fb["outcome"] == outcome, quality
        assert fb["evidence_source"] == "judge"
        assert fb.get("error_cause") == error_cause


def test_litellm_metadata_join_is_exact_for_concurrent_identical_prompts():
    router = _litellm_router()
    from minima_client.integrations.litellm_router import (
        MinimaFeedbackLogger,
        MinimaRoutingStrategy,
    )

    class _Counting(_MinimaStub):
        def recommend(self, task, **kwargs):
            self.recommend_calls.append({"task": task, **kwargs})
            return _RecStub(f"rec-{len(self.recommend_calls)}", _RankedStub(self.pick))

    minima = _Counting(pick="claude-haiku-4-5")
    strategy = MinimaRoutingStrategy(minima, router)
    messages = [{"role": "user", "content": "same prompt"}]
    # Two concurrent identical requests: the (group, task) LRU alone would collide.
    kw1: dict = {}
    kw2: dict = {}
    asyncio.run(
        strategy.async_get_available_deployment("my-group", messages=messages, request_kwargs=kw1)
    )
    asyncio.run(
        strategy.async_get_available_deployment("my-group", messages=messages, request_kwargs=kw2)
    )
    assert kw1["metadata"]["minima_rec_id"] == "rec-1"
    assert kw2["metadata"]["minima_rec_id"] == "rec-2"

    logger = MinimaFeedbackLogger(minima, strategy)
    response = type("Resp", (), {"usage": None})()
    start, end = datetime(2026, 1, 1), datetime(2026, 1, 1) + timedelta(seconds=1)
    # Completions land out of order; the in-band metadata still joins each exactly.
    for kw in (kw2, kw1):
        event = {
            "model": "my-group",
            "messages": messages,
            "litellm_params": {"metadata": kw["metadata"]},
        }
        asyncio.run(logger.async_log_success_event(event, response, start, end))
    assert [fb["rec_id"] for fb in minima.feedback_calls] == ["rec-2", "rec-1"]


# -------------------------------------------------------------- OpenHands ----


def test_openhands_router_selects_minima_pick():
    pytest.importorskip("openhands.sdk")
    from minima_client.integrations.openhands_router import MinimaRouterLLM
    from openhands.sdk.llm import LLM

    llms = {
        "cheap": LLM(model="anthropic/claude-haiku-4-5", usage_id="cheap"),
        "strong": LLM(model="anthropic/claude-sonnet-4-6", usage_id="strong"),
    }
    router = MinimaRouterLLM(
        model="minima-router", usage_id="router", llms_for_routing=llms
    )
    router.set_minima_client(_MinimaStub(pick="claude-sonnet-4-6"))

    class _Msg:
        role = "user"
        content = "prove this theorem"

    assert router.select_llm([_Msg()]) == "strong"


def test_openhands_router_fails_open_to_first_llm():
    pytest.importorskip("openhands.sdk")
    from minima_client.integrations.openhands_router import MinimaRouterLLM
    from openhands.sdk.llm import LLM

    llms = {"cheap": LLM(model="anthropic/claude-haiku-4-5", usage_id="cheap")}
    router = MinimaRouterLLM(model="minima-router", usage_id="router", llms_for_routing=llms)

    class _Down:
        def recommend(self, *a, **k):
            raise RuntimeError("unreachable")

    router.set_minima_client(_Down())
    assert router.select_llm([]) == "cheap"


def test_openhands_completion_reports_cost_telemetry():
    pytest.importorskip("openhands.sdk")
    import time as _time

    from minima_client.integrations.openhands_router import MinimaRouterLLM
    from openhands.sdk.llm import LLM

    llms = {"cheap": LLM(model="anthropic/claude-haiku-4-5", usage_id="cheap")}
    router = MinimaRouterLLM(model="minima-router", usage_id="router", llms_for_routing=llms)
    minima = _MinimaStub(pick="claude-haiku-4-5")
    router.set_minima_client(minima)

    # Stub the selected LLM's completion; simulate the metrics append the real call does.
    def _fake_completion(**kwargs):
        llms["cheap"].metrics.add_cost(0.0031)
        llms["cheap"].metrics.add_token_usage(
            prompt_tokens=150,
            completion_tokens=60,
            cache_read_tokens=0,
            cache_write_tokens=0,
            context_window=200000,
            response_id="r1",
        )
        return type("Resp", (), {"message": None, "metrics": None, "raw_response": None})()

    object.__setattr__(llms["cheap"], "completion", _fake_completion)

    class _Msg:
        role = "user"
        content = "summarize the doc"

    router.completion([_Msg()])
    for _ in range(50):  # fire-and-forget thread — wait for the feedback to land
        if minima.feedback_calls:
            break
        _time.sleep(0.02)
    fb = minima.feedback_calls[0]
    assert fb["rec_id"] == "rec-1"
    assert fb["model"] == "claude-haiku-4-5"
    assert fb["outcome"] == "success"
    assert fb["evidence_source"] == "none"  # telemetry, never a fabricated label
    assert fb["actual_cost_usd"] == pytest.approx(0.0031)
    assert fb["input_tokens"] == 150
    assert fb["output_tokens"] == 60


# ------------------------------------------------------------ minima-route ----


def test_minima_route_cli_recommend_and_feedback(monkeypatch, capsys):
    from minima_client.integrations import claude_code

    class _CtxStub(_MinimaStub):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

    stub = _CtxStub(pick="claude-haiku-4-5")
    monkeypatch.setattr(claude_code, "MinimaClient", lambda *a, **k: stub)

    rc = claude_code.main(
        ["recommend", "fix the bug", "--candidates", "claude-haiku-4-5,claude-sonnet-4-6"]
    )
    assert rc == 0
    assert capsys.readouterr().out.strip() == "claude-haiku-4-5"

    rc = claude_code.main(
        [
            "feedback",
            "rec-1",
            "claude-haiku-4-5",
            "success",
            "--cost",
            "0.002",
            "--input-tokens",
            "1200",
            "--source",
            "human",
        ]
    )
    assert rc == 0
    fb = stub.feedback_calls[0]
    assert fb["outcome"] == "success"
    assert fb["usage"].cost_usd == pytest.approx(0.002)
    assert fb["evidence_source"] == "human"
