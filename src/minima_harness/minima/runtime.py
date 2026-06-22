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
        except Exception:  # noqa: BLE001
            if not self.config.allow_offline:
                raise
            _log.warning("minima_recommend_failed_offline_fallback", exc_info=True)
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
                quality = clamp01(await self.judge.grade(task_text, output))
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
        "no_judge_configured_using_const_0_5 -- pass judge=LLMJudge/DeterministicJudge "
        "for real learning; set judge_every=0 to skip judging entirely"
    )
    return ConstJudge(0.5)


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
