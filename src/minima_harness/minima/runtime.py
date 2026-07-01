"""MinimaAgent — an :class:`~minima_harness.agent.Agent` that routes each prompt
through Minima and feeds the realized outcome back.

Per top-level ``prompt()``: (1) ask Minima which model and set ``state.model``, (2) run
the agent loop (delegate to the base Agent, so tool turns keep working), (3) judge the
final answer and send ``POST /v1/feedback`` with realized tokens/cost/latency. Routing is
bypassable: if Minima is unreachable and ``allow_offline`` is set, the run proceeds on the
current model with no feedback. Bookkeeping failures are logged-and-swallowed so the
Minima round-trip never breaks the caller's run.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any

from minima_harness.agent.agent import Agent
from minima_harness.agent.tools import ThinkingLevel
from minima_harness.ai.errors import classify_provider_error, is_auth_error
from minima_harness.ai.types import AssistantMessage, ContentBlock, Message, Model, Usage
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.judge import (
    ConstJudge,
    LLMJudge,
    QualityJudge,
    clamp01,
)
from minima_harness.minima.mapping import ModelMapping
from minima_harness.minima.meter import CostMeter
from minima_harness.minima.router import MinimaRouter, Ranking, RoutingResult
from minima_harness.minima.signals import ContextExtractor, extract_or_none
from minima_harness.tasks.task_set import grade_outcome

if TYPE_CHECKING:
    pass

_log = logging.getLogger("minima_harness.runtime")

# Inspect/override a recommendation before the model runs. Return a (possibly modified)
# RoutingResult to override the model; None to accept as-is; a result with
# recommendation_id=None to veto (run a different model with no feedback attribution).
BeforeRoute = Callable[[RoutingResult, str], Awaitable[RoutingResult | None]]


class MinimaAgent(Agent):
    def __init__(
        self,
        config: HarnessConfig,
        *,
        router: MinimaRouter | None = None,
        judge: QualityJudge | None = None,
        mapping: ModelMapping | None = None,
        model: Model | None = None,
        tools: list | None = None,
        system_prompt: str | None = None,
        task_type: str | None = None,
        thinking_level: ThinkingLevel = "off",
        max_turns: int = 50,
        meter: CostMeter | None = None,
        before_route: BeforeRoute | None = None,
        extractor: ContextExtractor | None = None,
    ) -> None:
        self.config = config
        self.mapping = mapping or (router.mapping if router else ModelMapping())
        self.router = router or MinimaRouter.for_config(config, self.mapping)
        self.judge = judge if judge is not None else _default_judge(config)
        self.meter = meter
        self.before_route = before_route
        self.extractor = extractor
        self._task_type_hint = task_type
        self._prompts_run = 0
        # Count of tool calls the human rejected this turn (diff-approval). A reject is a
        # ground-truth negative that overrides the (noisier) judge signal in feedback.
        self._rejected_tools = 0
        # Why the last route fell back to offline (None = routed fine). Surfaced by the TUI
        # so a degraded-to-offline turn is visible, not silent.
        self._offline_reason: str | None = None
        # Whether that offline fallback is worth retrying via /reconnect. False for config/auth
        # problems (no/invalid Mubit key) where retrying changes nothing — the user must fix a
        # credential. Lets the TUI show the right action instead of a misleading "/reconnect".
        self._offline_retryable: bool = True
        # Classified reason the last turn's model call failed (None = ran fine). A provider
        # error (bad key, 404, network) is swallowed into an empty assistant — this exposes it
        # so the TUI / --print can show *why* a turn produced no output, not a blank bubble.
        self._last_error: str | None = None
        # The provider's RAW error body (unclassified) for the last failed turn. The classified
        # `_last_error` is the clean headline; this preserves the provider's exact words (e.g.
        # Gemini's "RESOURCE_EXHAUSTED … quota …" vs "PERMISSION_DENIED …") so an ambiguous
        # 403/429 is self-diagnosing instead of guesswork.
        self._last_error_raw: str | None = None
        # Providers whose key hard-failed auth this session (bad/invalid key). Routing drops them
        # from the candidate set so it stops re-recommending a provider that can't run, and the
        # current turn is re-routed onto one that works. Cleared by /reconnect (key may be fixed).
        self._excluded_providers: set[str] = set()
        # One-line, user-facing note when a turn was auto-rerouted off a dead-key provider (None =
        # no reroute this turn). The TUI surfaces it so the silent provider switch is explained.
        self._reroute_note: str | None = None
        initial = model or self.mapping.default_model()
        super().__init__(
            model=initial,
            tools=list(tools or []),
            system_prompt=system_prompt,
            thinking_level=thinking_level,
            max_turns=max_turns,
        )

    async def prompt(  # type: ignore[override]  # widens base with optional routing kwargs
        self,
        content: str | list[ContentBlock] | Message | list[Any],
        *,
        task_type: str | None = None,
        slider: float | None = None,
        files: list[str | Path] | None = None,
        tags: list[str] | None = None,
    ) -> RoutingResult | None:
        task_text = _text_of(content)
        effective_task_type = task_type or self._task_type_hint
        self._prompts_run += 1
        self._rejected_tools = 0  # reset per-turn reject tally
        self._last_error = None  # reset per-turn error
        self._last_error_raw = None
        self._reroute_note = None  # reset per-turn auto-reroute note

        routing: RoutingResult | None = None
        last: AssistantMessage | None = None
        run_error: BaseException | None = None
        latency_ms = 0
        turns_taken = 0
        # Snapshot history so a failed turn can be rolled back out of the agent's context entirely.
        msgs_before = len(self.state.messages)
        # A hard auth failure (bad/invalid/missing key) is deterministic — the same provider fails
        # identically on every call. So when one occurs and a *different* provider's key works,
        # blacklist the dead provider for the session and re-run the SAME message on an alternative,
        # rescuing this turn instead of wasting it. The exclusion set grows by one per pass, so the
        # loop always terminates; range() is a hard backstop.
        for _attempt in range(self._reroute_budget() + 1):
            routing = await self._route(
                task_text, effective_task_type, slider, files=files, tags=tags, reroute=_attempt > 0
            )
            # On a RErouTE pass: if routing handed back a provider already blacklisted this turn,
            # re-running it would just fail identically — stop and surface the prior error. This
            # catches the cases the candidate filter can't: an offline route (which can't switch
            # models) and a recommender that ignores the candidate constraint and re-picks the dead
            # model. Gated to reroute passes so the FIRST attempt always runs (and surfaces a real
            # error) even when the only model's provider was excluded on a previous turn.
            run_provider = _provider_of(self.state.model.id if self.state.model else None)
            already_dead = run_provider is not None and run_provider in self._excluded_providers
            if _attempt > 0 and already_dead:
                break
            msgs_before = len(self.state.messages)
            start = monotonic()
            run_error = None
            try:
                await super().prompt(content)
            except BaseException as exc:  # noqa: BLE001 - capture, then re-raise after feedback
                run_error = exc
            latency_ms = int((monotonic() - start) * 1000)
            turns_taken = self.state.turns_taken
            last = self._last_assistant()
            # A provider call that failed (bad/missing key, 404, network) is swallowed by the
            # provider into an empty-text assistant with stop_reason="error" — NOT a raised
            # exception. Treat that as a failed turn so (a) Minima is never told a broken turn
            # "succeeded" (which would poison routing), and (b) the caller can surface why.
            provider_error = last is not None and getattr(last, "stop_reason", None) == "error"
            if provider_error and last is not None:
                self._last_error = classify_provider_error(last.error_message, last.model)
                self._last_error_raw = last.error_message
                # Log the raw provider error so it's recoverable even off the TUI (--print).
                _log.warning("provider_error_raw model=%s: %s", last.model, last.error_message)
            # Auto-reroute off a dead-key provider — but never second-guess an explicit pin.
            if (
                provider_error
                and run_error is None
                and last is not None
                and not self.config.pinned
                and is_auth_error(last.error_message)
            ):
                provider = _provider_of(last.model)
                if provider:
                    self._excluded_providers.add(provider)
                    if self._has_runnable_candidate():
                        self._note_reroute(provider)
                        del self.state.messages[msgs_before:]  # drop failed attempt, then retry
                        self._last_error = self._last_error_raw = None
                        continue
            break

        provider_error = last is not None and getattr(last, "stop_reason", None) == "error"
        if provider_error and last is not None:
            # The final loop pass may have cleared these on a reroute `continue` that then couldn't
            # actually switch providers (offline, or a recommender that re-picked the dead model).
            # Re-derive so a still-failing turn surfaces the real error (not a blank "success") and
            # drop the optimistic reroute note (the reroute did NOT rescue the turn).
            self._last_error = classify_provider_error(last.error_message, last.model)
            self._last_error_raw = last.error_message
            self._reroute_note = None
        # An auth/infra failure is a credential problem, not a model-quality signal — don't feed it
        # back to Minima (it would poison the model's success estimate in this namespace).
        auth_failed = bool(
            provider_error and last is not None and is_auth_error(last.error_message)
        )
        failed = run_error is not None or provider_error
        quality: float | None = None
        outcome = "success"
        if routing is not None and not auth_failed:
            quality, outcome = await self._feedback_safely(
                task_text, routing, latency_ms, failed, turns_taken
            )
        if self.meter is not None:
            actual = last.usage.cost.total if last is not None else 0.0
            self.meter.record(
                label=_short_label(task_text),
                routing=routing,
                actual_cost_usd=actual,
                quality=quality if not failed else 0.0,
                outcome=("failure" if failed else outcome),
                turns=turns_taken,
            )
        # Roll a failed turn fully out of the agent's context — both the empty error-assistant
        # AND the user message that triggered it. A failed turn produced no usable exchange, so
        # leaving it in history only poisons the NEXT turn (the loop's _drop_failed_calls guard
        # already strips the empty assistant; this also avoids a dangling user turn). Done after
        # feedback/meter so they still see the failed turn's signal.
        if failed:
            del self.state.messages[msgs_before:]
        if run_error is not None:
            raise run_error
        return routing

    # ------------------------------------------------------------------ routing

    async def _route(
        self,
        task_text: str,
        task_type: str | None,
        slider: float | None,
        *,
        files: list[str | Path] | None = None,
        tags: list[str] | None = None,
        reroute: bool = False,
    ) -> RoutingResult | None:
        # On a reroute pass the before_route hook (which emits the routing rationale line and, in
        # confirm mode, the confirmation modal) is skipped: a single user turn must produce ONE
        # routing line / ONE confirm, not one per auth-failed attempt. The auto-reroute note
        # explains the silent switch instead.
        run_hook = self.before_route is not None and not reroute
        # A hard pin (exactly one candidate, set via /model) bypasses Minima entirely: run that
        # model directly. Sending a single-model constraint to Minima fails with 422 when the
        # pinned id isn't in Minima's routing catalog (e.g. an OpenRouter-namespaced model like
        # `google/gemini-2.5-flash`), which then degraded to a *different* offline model. A pin
        # is a deliberate override — there's nothing to route — so we skip recommend.
        pinned = self._pinned_route()
        if pinned is not None:
            self._offline_reason = None
            self._offline_retryable = True
            if run_hook:
                overridden = await self.before_route(pinned, task_text)
                if overridden is not None:
                    pinned = overridden
            self.state.model = pinned.model
            return pinned
        bundle = await extract_or_none(
            self.extractor, task_text, [Path(f) for f in files] if files else None
        )
        # Merge caller-supplied tags (e.g. a goal tag, so a goal's turns cluster in Minima's
        # memory) with the code-derived signal tags.
        merged_tags = (bundle.tags if bundle else []) + (tags or [])
        tags = merged_tags or None
        difficulty = bundle.difficulty if bundle else None
        exp_tokens = bundle.expected_input_tokens if bundle else None
        try:
            routing = await self.router.recommend(
                task_text,
                task_type=task_type,
                slider=slider,
                tags=tags,
                difficulty=difficulty,
                expected_input_tokens=exp_tokens,
                candidates=self._effective_candidates(),
            )
            self._offline_reason = None
            self._offline_retryable = True
        except Exception as exc:  # noqa: BLE001
            if not self.config.allow_offline:
                raise
            has_key = bool((self.config.minima_api_key or "").strip())
            self._offline_reason, self._offline_retryable = _classify_offline_reason(exc, has_key)
            # Expected, recoverable degradation — log the concise reason at WARNING and keep the
            # full traceback at DEBUG so a healthy offline fallback doesn't dump a stack trace.
            _log.warning("minima_recommend_failed_offline_fallback: %s", self._offline_reason)
            _log.debug("offline_fallback_detail", exc_info=True)
            return None
        if run_hook:
            overridden = await self.before_route(routing, task_text)
            if overridden is not None:
                routing = overridden
        self.state.model = routing.model
        return routing

    def _pinned_route(self) -> RoutingResult | None:
        """If a single model is pinned (via /model), build a routing result for it directly —
        no Minima call. Returns None when not pinned or the pinned id can't be resolved to a
        registered model (then normal routing runs)."""
        from minima_harness.ai.registry import find_model_by_id

        cands = self.config.candidates or []
        if not self.config.pinned or len(cands) != 1:
            return None
        pinned_id = cands[0]
        model = find_model_by_id(pinned_id)
        if model is None and "/" in pinned_id:
            # tolerant resolve for openrouter-style "provider/model" ids
            model = self.mapping._resolve(pinned_id.split("/", 1)[0], pinned_id)
        if model is None:
            return None
        ranking = Ranking(
            model_id=pinned_id,
            provider=model.provider,
            predicted_success=1.0,
            est_cost_usd=0.0,
            decision_basis="pinned",
        )
        return RoutingResult(
            recommendation_id=None,  # manual pin — not a Minima recommendation to learn from
            chosen_model_id=pinned_id,
            model=model,
            est_cost_usd=0.0,
            decision_basis="pinned",
            ranked=[ranking],
            confidence=1.0,
        )

    # ------------------------------------------------------ key-aware candidates

    def _effective_candidates(self) -> list[str]:
        """Candidate model ids minus providers that can't run: those with no key configured at all
        (presence filter) and those whose key auth-failed this session. Never returns empty — if
        every provider is excluded, fall back to the key-present set so routing still attempts a
        model (and the auth banner explains the situation) rather than locking the user out."""
        from minima_harness.ai.provider_catalog import runnable_candidates

        eff = runnable_candidates(self.config.candidates)
        if self._excluded_providers:
            pruned = [c for c in eff if _provider_of(c) not in self._excluded_providers]
            eff = pruned or eff
        return eff

    def _reroute_budget(self) -> int:
        """Max auto-reroute passes for a turn = the number of distinct candidate providers, so each
        can be tried at most once before giving up."""
        provs = {_provider_of(c) for c in (self.config.candidates or [])}
        provs.discard(None)
        return max(1, len(provs))

    def _has_runnable_candidate(self) -> bool:
        """True if some candidate's provider has a key configured and isn't excluded this turn."""
        from minima_harness.ai.provider_catalog import provider_key_present

        for c in self.config.candidates or []:
            p = _provider_of(c)
            if p is None or p in self._excluded_providers:
                continue
            if provider_key_present(p):
                return True
        return False

    def _note_reroute(self, provider: str) -> None:
        """Record a one-line, user-facing explanation for an auto-reroute off a dead key."""
        from minima_harness.ai.provider_catalog import env_vars_for_provider, spec_for

        spec = spec_for(provider)
        pname = spec.display_name if spec else provider
        keyvar = env_vars_for_provider(provider)[0] if provider else ""
        hint = f" — fix {keyvar} (/config) to re-enable" if keyvar else ""
        self._reroute_note = f"{pname} key rejected; excluded this session{hint}"

    async def reconnect(self) -> None:
        """Rebuild the Minima client from the current environment.

        Routing auth + the endpoint URL are captured when the client is built, so a key or
        ``MINIMA_URL`` set via ``/config`` mid-session doesn't take effect until the client is
        rebuilt. ``/reconnect`` (and a routing-key change in ``/config``) call this so the fix
        applies without restarting the app. The stale client is closed best-effort.
        """
        self.config.refresh_routing_env()
        old = self.router
        self.router = MinimaRouter.for_config(self.config, self.mapping)
        self._offline_reason = None
        self._offline_retryable = True
        # A key fixed via /config (which triggers reconnect) may revive an auth-failed provider —
        # clear the session blacklist so routing can choose it again.
        self._excluded_providers.clear()
        await old.aclose()

    async def _feedback_safely(
        self,
        task_text: str,
        routing: RoutingResult,
        latency_ms: int,
        failed: bool,
        turns_taken: int = 0,
    ) -> tuple[float | None, str]:
        """Send feedback; return the (quality, outcome) used (for the meter). Never raises.

        ``failed`` is True when the turn raised OR the model returned a provider error
        (empty output) — either way the turn is a ground-truth failure, regardless of judging.
        """
        if routing.recommendation_id is None or routing.chosen_model_id is None:
            return None, "success"
        quality: float | None = None
        outcome = "success"
        try:
            last = self._last_assistant()
            usage = last.usage if last is not None else Usage()
            if failed:
                quality = 0.0
                outcome = "failure"
            elif not self._should_judge():
                quality = None
                outcome = "success"
            else:
                output = last.text if last is not None else ""
                graded = await self.judge.grade(task_text, output)
                if graded is None:
                    # Judge abstained (API error / unparseable): record realized cost &
                    # latency but send NO fabricated quality/outcome signal.
                    quality = None
                    outcome = "success"
                else:
                    quality = clamp01(graded)
                    outcome = grade_outcome(quality)
            if not failed and self._rejected_tools > 0:
                # A human rejected the model's edit(s): a strong ground-truth negative that
                # overrides the judge (applies even when judging is off).
                quality = min(quality if quality is not None else 0.25, 0.25)
                outcome = grade_outcome(quality)
            await self.router.feedback(
                routing.recommendation_id,
                routing.chosen_model_id,
                outcome,
                quality=quality,
                usage=usage,
                latency_ms=latency_ms,
                iterations=turns_taken or None,
            )
        except Exception:  # noqa: BLE001 - feedback must never break a successful run
            _log.warning("minima_feedback_failed", exc_info=True)
        return quality, outcome

    # ----------------------------------------------------------------- helpers

    def record_tool_rejection(self) -> None:
        """Called by the TUI when the human rejects a proposed edit (diff approval)."""
        self._rejected_tools += 1

    def _should_judge(self) -> bool:
        every = self.config.judge_every
        if every <= 0:
            return False
        return (self._prompts_run % every) == 0

    def _last_assistant(self) -> AssistantMessage | None:
        for m in reversed(self.state.messages):
            if m.role == "assistant":
                return m  # type: ignore[return-value]
        return None


def _default_judge(config: HarnessConfig) -> QualityJudge:
    """LLMJudge when an Anthropic key is present, else a neutral ConstJudge."""
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_OAUTH_TOKEN"):
        try:
            from minima_harness.ai import get_model

            return LLMJudge(get_model("anthropic", config.judge_model))
        except Exception:  # noqa: BLE001
            pass
    _log.warning(
        "no_judge_configured_abstaining -- pass judge=LLMJudge/DeterministicJudge for real "
        "learning; set judge_every=0 to skip judging entirely. Abstaining feeds NO quality "
        "signal (better than a fabricated neutral 0.5 that would poison the feedback loop)."
    )
    return ConstJudge(None)


def _classify_offline_reason(exc: BaseException, has_key: bool = True) -> tuple[str, bool]:
    """Why a route fell back to offline, plus whether retrying is worthwhile.

    Returns ``(reason, retryable)``. ``retryable`` is False for config/auth problems where
    ``/reconnect`` won't help on its own — the user must add or fix a credential first; the
    TUI uses this to show the actionable next step instead of a misleading "/reconnect".
    """
    status = getattr(exc, "status", None)
    if status in (401, 403):
        if not has_key:
            return ("no Mubit API key — add MUBIT_API_KEY via /config to enable routing", False)
        return ("Mubit API key rejected — check MUBIT_API_KEY (/config)", False)
    name = type(exc).__name__
    if "Timeout" in name:
        return ("Minima timed out", True)
    if "Connect" in name:
        return ("Minima unreachable", True)
    detail = str(exc).strip().splitlines()[0] if str(exc).strip() else name
    return (detail[:80], True)


def _text_of(content: str | list[ContentBlock] | Message | list[Any]) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, Message):
        return content.text
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Message):
                parts.append(item.text)
            else:
                parts.append(getattr(item, "text", ""))
        return "\n".join(p for p in parts if p)
    return str(content)


def _short_label(task_text: str) -> str:
    """One-line label for a cost-meter row (first non-empty line, truncated)."""
    first = (task_text.splitlines()[0] if task_text else "").strip()
    if len(first) > 48:
        first = first[:45] + "..."
    return first or "(empty)"


def _provider_of(model_id: str | None) -> str | None:
    """Provider name for a model id, or None if unknown/unregistered."""
    if not model_id:
        return None
    from minima_harness.ai.registry import find_model_by_id

    m = find_model_by_id(model_id)
    return m.provider if m else None
