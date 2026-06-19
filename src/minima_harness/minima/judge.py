"""Quality judging for the Minima feedback loop.

A judge turns a model's output into a [0, 1] quality score, which the router folds into
the outcome label it sends to ``POST /v1/feedback``. Three implementations cover the
common cases: an LLM grader (default when a key is present), a deterministic scorer
(wraps a ``quality_fn``, matching ``minima_harness.tasks``), and a constant for when
judging is disabled.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from minima_harness.ai import Context, Message, complete
from minima_harness.ai.types import Model

if TYPE_CHECKING:
    from collections.abc import Callable

_log = logging.getLogger("minima_harness.judge")

JUDGE_SYSTEM = (
    "You grade an AI assistant's response to a task on a 0-10 scale: 10 excellent, "
    "5 acceptable, 0 wrong. Judge correctness, completeness, and adherence to any rubric. "
    "Reply with ONLY a single integer 0-10, nothing else."
)


@runtime_checkable
class QualityJudge(Protocol):
    async def grade(self, task: str, output: str, *, rubric: str = "", expected: str = "") -> float:
        """Return a quality score in [0, 1]."""
        ...


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


class DeterministicJudge:
    """Wraps a ``quality_fn(output) -> float`` callable (the tasks/task_set convention)."""

    def __init__(self, fn: Callable[[str], float]) -> None:
        self._fn = fn

    async def grade(self, task: str, output: str, *, rubric: str = "", expected: str = "") -> float:
        try:
            return clamp01(float(self._fn(output)))
        except Exception:  # noqa: BLE001 - a broken scorer must not poison feedback
            _log.warning("deterministic_judge_failed", exc_info=True)
            return 0.0


class ConstJudge:
    """Returns a fixed quality (use to skip real judging; pairs with judge_every=0)."""

    def __init__(self, quality: float = 0.5) -> None:
        self._quality = clamp01(quality)

    async def grade(self, task: str, output: str, *, rubric: str = "", expected: str = "") -> float:
        return self._quality


class LLMJudge:
    """Grades via a cheap independent model (default claude-haiku). 0-10 -> /10 -> clamp.

    Uses the harness's own ``ai.complete`` so it shares provider plumbing; pick a
    different provider than your candidates to avoid self-grading bias.
    """

    def __init__(
        self,
        model: Model,
        *,
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._model = model
        self._api_key = api_key
        self._timeout = timeout

    async def grade(self, task: str, output: str, *, rubric: str = "", expected: str = "") -> float:
        user = f"TASK:\n{task[:4000]}\n\nRESPONSE:\n{output[:4000]}"
        if rubric:
            user += f"\n\nRUBRIC:\n{rubric[:1000]}"
        if expected:
            user += f"\n\nEXPECTED:\n{expected[:1000]}"
        options: dict = {"timeout": self._timeout}
        if self._api_key:
            options["api_key"] = self._api_key
        try:
            resp = await complete(
                self._model,
                Context(
                    system_prompt=JUDGE_SYSTEM,
                    messages=[Message(role="user", content=user)],
                ),
                options=options,
            )
        except Exception:  # noqa: BLE001
            _log.warning("llm_judge_call_failed", exc_info=True)
            return 0.0
        return clamp01(_parse_score(resp.text) / 10.0)


def _parse_score(text: str) -> float:
    """First integer 0-10 found in the text; defaults to 5 (neutral) if none."""
    for match in re.finditer(r"\d+", text):
        value = int(match.group())
        if 0 <= value <= 10:
            return float(value)
    return 5.0
