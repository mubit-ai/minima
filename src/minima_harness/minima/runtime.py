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
from minima_harness.minima.router import MinimaRouter, RoutingResult
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
    ) -> RoutingResult | None:
        task_text = _text_of(content)
        effective_task_type = task_type or self._task_type_hint
        self._prompts_run += 1
        self._rejected_tools = 0  # reset per-turn reject tally

        routing = await self._route(task_text, effective_task_type, slider, files=files)
        start = monotonic()
        run_error: BaseException | None = None
        try:
            await super().prompt(content)
        except BaseException as exc:  # noqa: BLE001 - capture, then re-raise after feedback
            run_error = exc

        latency_ms = int((monotonic() - start) * 1000)
        turns_taken = self.state.turns_taken
        quality: float | None = None
        outcome = "success"
        if routing is not None:
            quality, outcome = await self._feedback_safely(
                task_text, routing, latency_ms, run_error, turns_taken
            )
        if self.meter is not None:
            last = self._last_assistant()
            actual = last.usage.cost.total if last is not None else 0.0
            self.meter.record(
                label=_short_label(task_text),
                routing=routing,
                actual_cost_usd=actual,
                quality=quality if run_error is None else 0.0,
                outcome=("failure" if run_error is not None else outcome),
                turns=turns_taken,
            )
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
    ) -> RoutingResult | None:
        bundle = await extract_or_none(
            self.extractor, task_text, [Path(f) for f in files] if files else None
        )
        tags = bundle.tags if bundle else None
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
            )
            self._offline_reason = None
        except Exception as exc:  # noqa: BLE001
            if not self.config.allow_offline:
                raise
            self._offline_reason = _classify_offline_reason(exc)
            # Expected, recoverable degradation — log the concise reason at WARNING and keep the
            # full traceback at DEBUG so a healthy offline fallback doesn't dump a stack trace.
            _log.warning("minima_recommend_failed_offline_fallback: %s", self._offline_reason)
            _log.debug("offline_fallback_detail", exc_info=True)
            return None
        if self.before_route is not None:
            overridden = await self.before_route(routing, task_text)
            if overridden is not None:
                routing = overridden
        self.state.model = routing.model
        return routing

    async def _feedback_safely(
        self,
        task_text: str,
        routing: RoutingResult,
        latency_ms: int,
        run_error: BaseException | None,
        turns_taken: int = 0,
    ) -> tuple[float | None, str]:
        """Send feedback; return the (quality, outcome) used (for the meter). Never raises."""
        if routing.recommendation_id is None or routing.chosen_model_id is None:
            return None, "success"
        quality: float | None = None
        outcome = "success"
        try:
            last = self._last_assistant()
            usage = last.usage if last is not None else Usage()
            if run_error is not None:
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
            if run_error is None and self._rejected_tools > 0:
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


def _classify_offline_reason(exc: BaseException) -> str:
    """A short, human-readable reason a route fell back to offline (for the TUI banner)."""
    name = type(exc).__name__
    if "Timeout" in name:
        return "Minima timed out"
    if "Connect" in name:
        return "Minima unreachable"
    detail = str(exc).strip().splitlines()[0] if str(exc).strip() else name
    return detail[:80]


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
