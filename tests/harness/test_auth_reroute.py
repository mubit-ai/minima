"""Auth-failure reroute (the 'router keeps choosing a provider whose key is invalid' bug).

When a provider's key is bad/invalid, every call to it 401s identically. These tests prove the
harness now: (1) drops keyless providers from routing up front, (2) blacklists a provider that
auth-fails for the rest of the session, (3) re-runs the SAME turn on a provider whose key works,
and (4) never feeds a credential failure back to Minima as a model-quality signal.
"""

from __future__ import annotations

import asyncio

from minima_harness.ai import AssistantMessage, TextContent
from minima_harness.ai.providers import register_faux_provider
from minima_harness.ai.registry import _MODELS, register_model
from minima_harness.ai.types import Modality, Model, ModelCost
from minima_harness.minima import HarnessConfig, MinimaAgent, ModelMapping, RoutingResult

_AUTH_401 = (
    "Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', "
    "'message': 'invalid x-api-key'}}"
)


def _model(model_id: str, provider: str) -> Model:
    return Model(
        id=model_id,
        provider=provider,
        api="faux",  # dispatch is by .api → the faux provider serves it
        name=model_id,
        cost=ModelCost(input=0.0, output=0.0),
        context_window=8192,
        max_tokens=4096,
        input=(Modality.text,),
    )


def _ok(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextContent(text=text)], stop_reason="stop")


def _auth_error() -> AssistantMessage:
    return AssistantMessage(
        content=[TextContent(text="")], stop_reason="error", error_message=_AUTH_401
    )


class CandidateRouter:
    """Returns the *first* candidate it is handed (so ``_effective_candidates`` filtering decides
    which model runs), and records the candidate sets + any feedback for assertions."""

    def __init__(self) -> None:
        self.mapping = ModelMapping()
        self.candidate_calls: list[list[str] | None] = []
        self.feedback_calls: list[dict] = []

    async def aclose(self) -> None:  # pragma: no cover - trivial
        pass

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
        from minima_harness.ai.registry import find_model_by_id

        self.candidate_calls.append(list(candidates) if candidates is not None else None)
        cid = (candidates or [None])[0]
        return RoutingResult(
            recommendation_id="rec",
            chosen_model_id=cid,
            model=find_model_by_id(cid) if cid else None,
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(
        self, rec_id, chosen, outcome, *, quality, usage, latency_ms, iterations=None
    ):
        self.feedback_calls.append({"chosen": chosen, "outcome": outcome})


class ConstantRouter:
    """A misbehaving recommender that IGNORES the candidate constraint and always returns the same
    model id — used to prove the loop doesn't spin re-running an already-blacklisted provider."""

    def __init__(self, model_id: str) -> None:
        self.mapping = ModelMapping()
        self._mid = model_id
        self.feedback_calls: list[dict] = []

    async def aclose(self) -> None:  # pragma: no cover - trivial
        pass

    async def recommend(self, task, *, candidates=None, **_):
        from minima_harness.ai.registry import find_model_by_id

        return RoutingResult(
            recommendation_id="rec",
            chosen_model_id=self._mid,
            model=find_model_by_id(self._mid),
            est_cost_usd=0.001,
            decision_basis="memory",
        )

    async def feedback(self, *a, **k):
        self.feedback_calls.append(k)


class OfflineRouter:
    """recommend() always raises → exercises the allow_offline fallback (routing returns None)."""

    def __init__(self) -> None:
        self.mapping = ModelMapping()
        self.feedback_calls: list[dict] = []

    async def aclose(self) -> None:  # pragma: no cover - trivial
        pass

    async def recommend(self, *a, **k):
        raise RuntimeError("minima unreachable")

    async def feedback(self, *a, **k):
        self.feedback_calls.append(k)


def _register(*models: Model) -> None:
    for m in models:
        register_model(m)


def _cleanup(*models: Model) -> None:
    for m in models:
        _MODELS.pop((m.provider, m.id), None)


# --------------------------------------------------------------- candidate filtering (unit)


def test_effective_candidates_drops_keyless_provider(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    a, b = _model("ka-anth", "anthropic"), _model("kb-goog", "google")
    _register(a, b)
    try:
        agent = MinimaAgent(
            HarnessConfig(candidates=["ka-anth", "kb-goog"]), router=CandidateRouter(), model=b
        )
        # anthropic has no key configured → presence filter drops it before routing.
        assert agent._effective_candidates() == ["kb-goog"]
    finally:
        _cleanup(a, b)


def test_effective_candidates_excludes_auth_failed_provider(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    a, b = _model("xa-anth", "anthropic"), _model("xb-goog", "google")
    _register(a, b)
    try:
        agent = MinimaAgent(
            HarnessConfig(candidates=["xa-anth", "xb-goog"]), router=CandidateRouter(), model=a
        )
        assert set(agent._effective_candidates()) == {"xa-anth", "xb-goog"}
        agent._excluded_providers.add("anthropic")
        assert agent._effective_candidates() == ["xb-goog"]
    finally:
        _cleanup(a, b)


def test_effective_candidates_never_empties(monkeypatch):
    # Even if every provider is excluded, routing still gets *something* (the auth banner explains)
    # rather than an empty constraint that would lock the user out.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    a = _model("solo-anth", "anthropic")
    _register(a)
    try:
        agent = MinimaAgent(
            HarnessConfig(candidates=["solo-anth"]), router=CandidateRouter(), model=a
        )
        agent._excluded_providers.add("anthropic")
        assert agent._effective_candidates() == ["solo-anth"]  # fell back, not empty
    finally:
        _cleanup(a)


# --------------------------------------------------------------- end-to-end reroute


def test_auth_failure_blacklists_provider_and_reroutes(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")  # present, but the provider will 401
    monkeypatch.setenv("GEMINI_API_KEY", "gm-good")  # present and works
    a, b = _model("e2e-anth", "anthropic"), _model("e2e-goog", "google")
    _register(a, b)
    try:
        with register_faux_provider(models=[a, b]) as reg:
            reg.set_responses([_auth_error(), _ok("rerouted answer")])
            router = CandidateRouter()
            agent = MinimaAgent(
                HarnessConfig(candidates=["e2e-anth", "e2e-goog"], judge_every=0),
                router=router,
                model=a,
            )
            routing = asyncio.run(agent.prompt("hi"))
        # The turn was rescued on the google model after anthropic's key was rejected.
        assert routing is not None and routing.chosen_model_id == "e2e-goog"
        assert "anthropic" in agent._excluded_providers
        assert agent._last_error is None  # final attempt succeeded → no error surfaced
        assert agent._reroute_note and "Anthropic" in agent._reroute_note
        assert "ANTHROPIC_API_KEY" in agent._reroute_note
        # First route saw both candidates; the retry saw anthropic dropped.
        assert router.candidate_calls[0] == ["e2e-anth", "e2e-goog"]
        assert router.candidate_calls[1] == ["e2e-goog"]
        # Only the successful google route was reported to Minima — the dead-key 401 was NOT.
        assert [f["chosen"] for f in router.feedback_calls] == ["e2e-goog"]
        assert router.feedback_calls[0]["outcome"] == "success"
    finally:
        _cleanup(a, b)


def test_misbehaving_router_repicking_dead_provider_does_not_spin(monkeypatch):
    # A recommender that ignores the candidate constraint and keeps returning the dead model must
    # not burn the whole reroute budget hammering it — the loop breaks once the provider is known
    # dead, and the turn surfaces the real error (NOT a blank "successful" reroute).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-good")
    a, b = _model("spin-anth", "anthropic"), _model("spin-goog", "google")
    _register(a, b)
    try:
        with register_faux_provider(models=[a, b]) as reg:
            reg.set_responses([_auth_error(), _auth_error(), _auth_error()])
            router = ConstantRouter("spin-anth")  # always re-picks the dead provider
            agent = MinimaAgent(
                HarnessConfig(candidates=["spin-anth", "spin-goog"], judge_every=0),
                router=router,
                model=a,
            )
            asyncio.run(agent.prompt("hi"))
        assert reg.state.call_count == 1  # ran the dead model once, then broke — no spin
        assert agent._last_error and "Authentication failed" in agent._last_error
        assert agent._reroute_note is None  # failed turn must not claim a successful reroute
        assert router.feedback_calls == []  # auth failure not reported to Minima
    finally:
        _cleanup(a, b)


def test_offline_auth_failure_does_not_spin_or_falsely_reroute(monkeypatch):
    # Offline (Minima unreachable) the route can't switch models, so an auth failure can't be
    # rescued. It must fail cleanly after ONE call with the real error — not spin, not claim a
    # reroute that never happened.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-good")
    a, b = _model("off-anth", "anthropic"), _model("off-goog", "google")
    _register(a, b)
    try:
        with register_faux_provider(models=[a, b]) as reg:
            reg.set_responses([_auth_error(), _ok("never runs")])
            agent = MinimaAgent(
                HarnessConfig(
                    candidates=["off-anth", "off-goog"], allow_offline=True, judge_every=0
                ),
                router=OfflineRouter(),
                model=a,
            )
            asyncio.run(agent.prompt("hi"))
        assert reg.state.call_count == 1  # dead model run exactly once
        assert reg.state.pending_response_count == 1  # the success response was never reached
        assert agent._last_error and "Authentication failed" in agent._last_error
        assert agent._reroute_note is None
        assert "anthropic" in agent._excluded_providers
    finally:
        _cleanup(a, b)


def test_offline_turn_with_already_excluded_model_still_surfaces_error(monkeypatch):
    # A LATER offline turn whose stuck model belongs to a provider excluded on a prior turn must
    # still run once and surface the auth error — not silently no-op (the reroute-pass break must
    # not fire on the first attempt).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    a = _model("stuck-anth", "anthropic")
    _register(a)
    try:
        with register_faux_provider(models=[a]) as reg:
            reg.set_responses([_auth_error()])
            agent = MinimaAgent(
                HarnessConfig(candidates=["stuck-anth"], allow_offline=True, judge_every=0),
                router=OfflineRouter(),
                model=a,
            )
            agent._excluded_providers.add("anthropic")  # excluded on an earlier turn
            asyncio.run(agent.prompt("hi"))
        assert reg.state.call_count == 1  # ran once (not a silent no-op)
        assert agent._last_error and "Authentication failed" in agent._last_error
        assert agent._reroute_note is None
    finally:
        _cleanup(a)


def test_before_route_hook_runs_once_despite_reroute(monkeypatch):
    # The before_route hook drives the TUI's routing line + confirm modal — it must fire ONCE per
    # user turn, not once per auth-failed attempt.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-good")
    a, b = _model("hook-anth", "anthropic"), _model("hook-goog", "google")
    _register(a, b)
    calls: list[str] = []

    async def hook(routing, task):
        calls.append(routing.chosen_model_id)
        return None

    try:
        with register_faux_provider(models=[a, b]) as reg:
            reg.set_responses([_auth_error(), _ok("rerouted answer")])
            agent = MinimaAgent(
                HarnessConfig(candidates=["hook-anth", "hook-goog"], judge_every=0),
                router=CandidateRouter(),
                model=a,
                before_route=hook,
            )
            asyncio.run(agent.prompt("hi"))
        assert calls == ["hook-anth"]  # fired only on the first route, not the reroute pass
    finally:
        _cleanup(a, b)


def test_auth_failure_without_alternative_is_not_fed_back(monkeypatch):
    # Only one provider candidate and it auth-fails → no alternative to reroute to. The turn fails,
    # the provider is still blacklisted, but the failure is NOT reported to Minima.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    a = _model("noalt-anth", "anthropic")
    _register(a)
    try:
        with register_faux_provider(models=[a]) as reg:
            reg.set_responses([_auth_error()])
            router = CandidateRouter()
            agent = MinimaAgent(
                HarnessConfig(candidates=["noalt-anth"], judge_every=0), router=router, model=a
            )
            asyncio.run(agent.prompt("hi"))
        assert "anthropic" in agent._excluded_providers  # blacklisted for the session
        assert router.feedback_calls == []  # but Minima was never told the model "failed"
        assert agent._last_error and "Authentication failed" in agent._last_error
    finally:
        _cleanup(a)


def test_pinned_model_is_not_rerouted_on_auth_failure(monkeypatch):
    # A hard pin is a deliberate override — never auto-reroute off it.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    monkeypatch.setenv("GEMINI_API_KEY", "gm-good")
    a, b = _model("pin-anth", "anthropic"), _model("pin-goog", "google")
    _register(a, b)
    try:
        with register_faux_provider(models=[a, b]) as reg:
            reg.set_responses([_auth_error(), _ok("should not run")])
            router = CandidateRouter()
            agent = MinimaAgent(
                HarnessConfig(candidates=["pin-anth"], pinned=True, judge_every=0),
                router=router,
                model=a,
            )
            asyncio.run(agent.prompt("hi"))
        assert agent._excluded_providers == set()  # pin respected — no blacklist, no reroute
        assert agent._last_error and "Authentication failed" in agent._last_error
        assert reg.state.pending_response_count == 1  # the fallback response was never consumed
        assert router.candidate_calls == []  # pin bypasses Minima entirely
    finally:
        _cleanup(a, b)


def test_reconnect_clears_the_session_blacklist(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    a = _model("rc-anth", "anthropic")
    _register(a)
    try:
        agent = MinimaAgent(
            HarnessConfig(candidates=["rc-anth"]), router=CandidateRouter(), model=a
        )
        agent._excluded_providers.add("anthropic")
        asyncio.run(agent.reconnect())
        assert agent._excluded_providers == set()
    finally:
        _cleanup(a)


def test_reroute_budget_counts_distinct_providers():
    a, b = _model("budg-anth", "anthropic"), _model("budg-goog", "google")
    _register(a, b)
    try:
        agent = MinimaAgent(
            HarnessConfig(candidates=["budg-anth", "budg-goog", "budg-anth"]),
            router=CandidateRouter(),
            model=a,
        )
        assert agent._reroute_budget() == 2  # two distinct providers (anthropic, google)
    finally:
        _cleanup(a, b)
