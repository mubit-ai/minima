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
    def __init__(self, model, *, recommend_model_id="faux", fail_recommend=False, fail_exc=None):
        self.model = model
        self.mapping = ModelMapping()
        self.recommend_calls: list[dict] = []
        self.feedback_calls: list[dict] = []
        self._fail = fail_recommend or fail_exc is not None
        self._fail_exc = fail_exc or RuntimeError("minima unreachable")
        self._recommend_model_id = recommend_model_id
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True

    async def recommend(
        self,
        task,
        *,
        task_type=None,
        slider=None,
        tags=None,
        difficulty=None,
        expected_input_tokens=None,
        candidates=None,
    ):
        self.recommend_calls.append(
            {
                "task": task,
                "task_type": task_type,
                "slider": slider,
                "tags": tags,
                "candidates": candidates,
            }
        )
        if self._fail:
            raise self._fail_exc
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


def test_prompt_merges_caller_tags_into_recommend():
    # A goal's tags (passed to prompt) must reach recommend so the goal clusters in memory.
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ok")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0), router=router, model=faux_model
        )
        asyncio.run(agent.prompt("do x", tags=["goal:ship-oauth"]))
    assert "goal:ship-oauth" in (router.recommend_calls[0]["tags"] or [])


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


def test_rejected_edit_overrides_to_failure():
    # Even with a high judge score, a rejected edit is a ground-truth negative.
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("done")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.95),
            model=faux_model,
        )
        agent.state.messages.append(_text_msg("done"))
        agent.record_tool_rejection()  # simulate a user rejecting the proposed edit
        routing = RoutingResult(
            recommendation_id="rec-1",
            chosen_model_id="faux",
            model=faux_model,
            est_cost_usd=0.001,
            decision_basis="memory",
        )
        quality, outcome = asyncio.run(
            agent._feedback_safely("task", routing, 10, False, 1)  # noqa: SLF001
        )
    assert outcome == "failure"
    assert quality is not None and quality <= 0.25
    assert router.feedback_calls[0]["outcome"] == "failure"


def test_provider_error_turn_is_failure_and_sets_last_error():
    # The faux provider yields a provider ErrorEvent (empty output, stop_reason="error") when
    # its response queue is empty — the same shape a real 401/404/network error produces. Such
    # a turn must be reported to Minima as a FAILURE (not success) even when judging is off,
    # and the classified reason must be exposed for the UI.
    with register_faux_provider() as reg:
        faux_model = reg.get_model()  # no responses queued -> error turn
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),  # judging OFF
            router=router,
            judge=DeterministicJudge(lambda t: 0.99),  # would say "success" if consulted
            model=faux_model,
        )
        asyncio.run(agent.prompt("hi"))
    assert router.feedback_calls[0]["outcome"] == "failure"
    assert router.feedback_calls[0]["quality"] == 0.0
    assert agent._last_error  # classified reason exposed for the TUI / --print
    # the provider's RAW words are preserved too, for diagnosing ambiguous 403/429s
    assert agent._last_error_raw == "No more faux responses queued"


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


def test_default_timeout_covers_reasoner_latency():
    # Cold-start recommend with the reasoner can exceed 10s; the default must not silently
    # time out into offline routing.
    assert HarnessConfig().timeout >= 30.0


def test_from_env_reads_minima_timeout(monkeypatch):
    monkeypatch.setenv("MINIMA_TIMEOUT", "45")
    assert HarnessConfig.from_env().timeout == 45.0


def test_classify_offline_reason():
    from minima_client.errors import MinimaError

    from minima_harness.minima.runtime import _classify_offline_reason

    class ReadTimeout(Exception):
        pass

    class ConnectError(Exception):
        pass

    # transient causes are retryable (/reconnect framing)
    assert _classify_offline_reason(ReadTimeout()) == ("Minima timed out", True)
    assert _classify_offline_reason(ConnectError()) == ("Minima unreachable", True)
    assert _classify_offline_reason(RuntimeError("boom")) == ("boom", True)

    # auth/config causes are NOT retryable — the reason carries the actionable next step
    no_key_reason, retryable = _classify_offline_reason(MinimaError(401, "x"), has_key=False)
    assert retryable is False
    assert "MUBIT_API_KEY" in no_key_reason and "/config" in no_key_reason
    bad_key_reason, retryable = _classify_offline_reason(MinimaError(401, "x"), has_key=True)
    assert retryable is False
    assert "rejected" in bad_key_reason
    assert _classify_offline_reason(MinimaError(403, "x"), has_key=True)[1] is False


def test_offline_fallback_records_reason():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model, fail_recommend=True)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], allow_offline=True),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux_model,
        )
        asyncio.run(agent.prompt("hi"))
    assert agent._offline_reason == "minima unreachable"  # surfaced by the TUI banner


def test_offline_reason_cleared_on_successful_route():
    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=FakeRouter(faux_model),
            model=faux_model,
        )
        agent._offline_reason = "stale"  # simulate a prior offline turn
        asyncio.run(agent.prompt("hi"))
    assert agent._offline_reason is None


def test_recommend_short_circuits_without_key_on_hosted():
    """A hosted Minima with no key never makes the doomed 401 round-trip."""
    from minima_client.errors import MinimaError

    from minima_harness.minima.router import MinimaRouter, _needs_auth

    # remote hosts need auth; loopback / empty do not (keyless local servers stay allowed)
    assert _needs_auth("https://api.minima.sh") is True
    assert _needs_auth("http://localhost:8080") is False
    assert _needs_auth("http://127.0.0.1:8080") is False
    assert _needs_auth("") is False

    cfg = HarnessConfig(minima_url="https://example.invalid", minima_api_key=None)
    router = MinimaRouter.for_config(cfg)
    try:
        asyncio.run(router.recommend("hi"))
        raise AssertionError("expected a MinimaError 401 short-circuit")
    except MinimaError as exc:
        assert exc.status == 401
    finally:
        asyncio.run(router.aclose())


def test_offline_without_key_is_not_retryable():
    """No-key 401 → offline fallback flagged non-retryable with an actionable reason."""
    from minima_client.errors import MinimaError

    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ans")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model, fail_exc=MinimaError(401, "no Mubit API key configured"))
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], minima_api_key=None, allow_offline=True),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux_model,
        )
        asyncio.run(agent.prompt("hi"))
    assert agent._offline_retryable is False
    assert "MUBIT_API_KEY" in (agent._offline_reason or "")


def test_failed_turn_rolls_back_and_does_not_poison_next():
    """A failed turn must leave NO trace in history, so the NEXT turn's request is valid.

    Regression for the cascade where a provider error left an empty assistant in context →
    the next call (even to a healthy provider) got 400 'text content blocks must be non-empty'.
    """
    from minima_harness.ai import AssistantMessage, TextContent

    with register_faux_provider() as reg:
        faux = reg.get_model()
        reg.set_responses(
            [
                # turn 1: provider error (empty assistant, like a swallowed 403)
                AssistantMessage(
                    content=[TextContent(text="")], stop_reason="error", error_message="403"
                ),
                _text_msg("the answer"),  # turn 2: a healthy response
            ]
        )
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=0),
            router=FakeRouter(faux),
            model=faux,
        )
        asyncio.run(agent.prompt("q1"))  # fails
        assert agent._last_error is not None  # the failure is still surfaced
        assert agent.state.messages == []  # …but fully rolled out of context

        asyncio.run(agent.prompt("q2"))  # succeeds on clean history
    assert [m.role for m in agent.state.messages] == ["user", "assistant"]
    # no empty error-assistant lingering to poison a future turn
    assert all(getattr(m, "stop_reason", None) != "error" for m in agent.state.messages)


def test_pinned_model_bypasses_minima_routing():
    """A hard pin runs that model directly — no recommend call (so no 422 on an OpenRouter id),
    and the pinned model (not an offline fallback) is what runs."""
    from minima_harness.ai.registry import _MODELS, register_model

    with register_faux_provider() as reg:
        reg.set_responses([_text_msg("ok")])
        faux = reg.get_model()  # id "faux"
        register_model(faux)  # the picker only offers registered models, so a pin resolves
        try:
            # This router RAISES if recommend is consulted — proves the pin bypasses it.
            router = FakeRouter(faux, fail_recommend=True)
            agent = MinimaAgent(
                HarnessConfig(candidates=["faux"], pinned=True, judge_every=0),  # explicit pin
                router=router,
                model=faux,
            )
            routing = asyncio.run(agent.prompt("hi"))
        finally:
            _MODELS.pop((faux.provider, faux.id), None)
    assert routing is not None
    assert routing.decision_basis == "pinned"
    assert routing.chosen_model_id == "faux"
    assert routing.recommendation_id is None  # no Minima attribution for a manual pin
    assert router.recommend_calls == []  # Minima was NOT consulted (no 422 possible)
    assert agent._offline_reason is None  # it's a pin, not an offline fallback


def test_drop_failed_calls_filters_error_assistants():
    """The loop-level guard never sends a failed call's assistant to a provider."""
    from minima_harness.agent.loop import _drop_failed_calls
    from minima_harness.ai import AssistantMessage, Message, TextContent

    msgs = [
        Message(role="user", content="q1"),
        AssistantMessage(content=[TextContent(text="")], stop_reason="error"),
        Message(role="user", content="q2"),
        AssistantMessage(content=[TextContent(text="real")], stop_reason="stop"),
    ]
    kept = _drop_failed_calls(msgs)
    assert [m.role for m in kept] == ["user", "user", "assistant"]
    assert all(getattr(m, "stop_reason", None) != "error" for m in kept)


def test_reconnect_rebuilds_client_with_current_key(monkeypatch):
    """A key set after launch (via /config) takes effect on reconnect — no restart."""
    from minima_harness.minima.router import MinimaRouter

    monkeypatch.delenv("MINIMA_API_KEY", raising=False)
    monkeypatch.setenv("MUBIT_API_KEY", "test-key-xyz")
    monkeypatch.setenv("MINIMA_URL", "https://api.minima.sh")

    with register_faux_provider() as reg:
        faux_model = reg.get_model()
        stale = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(
                minima_url="https://api.minima.sh", minima_api_key=None, candidates=["faux"]
            ),
            router=stale,
            model=faux_model,
        )
        asyncio.run(agent.reconnect())

    assert stale.closed is True  # old client disposed
    assert isinstance(agent.router, MinimaRouter)
    assert agent.config.minima_api_key == "test-key-xyz"
    # the rebuilt client carries the Authorization header the prior one lacked
    auth = agent.router._client._client.headers.get("authorization")
    assert auth == "Bearer test-key-xyz"
    asyncio.run(agent.router.aclose())


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
