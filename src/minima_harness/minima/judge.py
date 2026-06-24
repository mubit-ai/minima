"""Quality judging for the Minima feedback loop.

A judge turns a model's output into a [0, 1] quality score, which the router folds into
the outcome label it sends to ``POST /v1/feedback``. Three implementations cover the
common cases: an LLM grader (default when a key is present), a deterministic scorer
(wraps a ``quality_fn``, matching ``minima_harness.tasks``), and a constant for when
judging is disabled.

``grade`` returns ``float | None``: ``None`` means the judge ABSTAINS — it could not
produce a trustworthy score (LLM call failed, output unparseable, or no judge
configured). Abstention is NOT a failure: feeding a fabricated 0.0 (API error) or a
neutral 0.5 (unparseable) into ``/v1/feedback`` poisons the learning loop, so the caller
records the realized cost/latency but sends NO quality/outcome signal on abstention.
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
    async def grade(
        self, task: str, output: str, *, rubric: str = "", expected: str = ""
    ) -> float | None:
        """Return a quality score in [0, 1], or ``None`` to abstain (no trustworthy score)."""
        ...


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


class DeterministicJudge:
    """Wraps a ``quality_fn(output) -> float`` callable (the tasks/task_set convention)."""

    def __init__(self, fn: Callable[[str], float]) -> None:
        self._fn = fn

    async def grade(
        self, task: str, output: str, *, rubric: str = "", expected: str = ""
    ) -> float | None:
        try:
            return clamp01(float(self._fn(output)))
        except Exception:  # noqa: BLE001 - a broken scorer must ABSTAIN, not record a failure
            _log.warning("deterministic_judge_failed", exc_info=True)
            return None


class ConstJudge:
    """Returns a fixed quality (or ``None`` to abstain). ``ConstJudge(None)`` = always abstain."""

    def __init__(self, quality: float | None = 0.5) -> None:
        self._quality = clamp01(quality) if quality is not None else None

    async def grade(
        self, task: str, output: str, *, rubric: str = "", expected: str = ""
    ) -> float | None:
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

    async def grade(
        self, task: str, output: str, *, rubric: str = "", expected: str = ""
    ) -> float | None:
        user = f"TASK:\n{task[:4000]}\n\nRESPONSE:\n{output[:4000]}"
        if rubric:
            user += f"\n\nRUBRIC:\n{rubric[:1000]}"
        if expected:
            user += f"\n\nEXPECTED:\n{expected[:1000]}"
        # Judge inputs (task + response) are unique per turn, so prompt caching would only
        # incur a cache-write with no future read — disable it.
        options: dict = {"timeout": self._timeout, "prompt_cache": False}
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
        except Exception:  # noqa: BLE001 - a judge API error is NOT a model failure: abstain
            _log.warning("llm_judge_call_failed", exc_info=True)
            return None
        score = _parse_score(resp.text)
        # Unparseable judge output -> abstain rather than fabricate a neutral 0.5.
        return None if score is None else clamp01(score / 10.0)


def _parse_score(text: str) -> float | None:
    """Extract a 0-10 integer score from the judge's reply; ``None`` when none is found.

    The judge is asked for a bare integer, but real replies vary. Prefer, in order:
    an exact single integer, an ``N/10`` form, a ``score/rating/grade: N`` form, and
    finally the LAST standalone 0-10 integer (judges tend to conclude with the score,
    e.g. "there were 3 issues, so 7"). Returns ``None`` only when no 0-10 integer exists.
    """
    t = text.strip()
    if re.fullmatch(r"\d+", t) and 0 <= int(t) <= 10:
        return float(t)
    m = re.search(r"\b(\d+)\s*/\s*10\b", t)
    if m and 0 <= int(m.group(1)) <= 10:
        return float(m.group(1))
    m = re.search(r"(?:score|rating|grade)\D{0,5}(\d+)", t, re.IGNORECASE)
    if m and 0 <= int(m.group(1)) <= 10:
        return float(m.group(1))
    candidates = [int(x) for x in re.findall(r"\d+", t) if 0 <= int(x) <= 10]
    return float(candidates[-1]) if candidates else None
