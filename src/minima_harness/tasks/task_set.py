"""Task corpus for harness runs.

A :class:`Task` carries both the deterministic ``quality_fn`` (cheap, offline grading)
and the richer ``rubric``/``expected`` fields the LLM judge consumes (Phase 3). Either
grading path is optional: a task with ``quality_fn=None`` and an empty ``rubric`` just
records tokens/cost with a neutral outcome.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

QualityFn = Callable[[str], float]


@dataclass(slots=True)
class Task:
    """A single graded task."""

    label: str
    prompt: str
    task_type: str  # code | qa | reasoning | extraction | creative | ...
    quality_fn: QualityFn | None = None  # (model_output) -> float in [0, 1]
    slider: float = 5.0  # cost/quality tradeoff: 1.0=cheapest, 10.0=best quality
    rubric: str = ""  # consumed by the LLM judge (Phase 3)
    expected: str = ""  # reference answer for the judge / deterministic checks
    tags: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        assert 0.0 < self.slider <= 10.0, f"slider must be in (0, 10], got {self.slider}"


# Outcome thresholds mirror examples/agent_warmup.py so feedback labels are consistent.
SUCCESS_THRESHOLD = 0.8
PARTIAL_THRESHOLD = 0.4


def grade_outcome(quality: float) -> str:
    """Map a [0, 1] quality score to a Minima outcome label."""
    if quality >= SUCCESS_THRESHOLD:
        return "success"
    if quality >= PARTIAL_THRESHOLD:
        return "partial"
    return "failure"


# ---------------------------------------------------------------------------
# Seed corpus (3 tasks ported from the old agent/task_set.py, enriched)
# ---------------------------------------------------------------------------

TASKS: list[Task] = [
    Task(
        label="order-extract",
        prompt="Extract order id and total from: 'Order #A-9931 totalling $48.20 shipped.'",
        task_type="extraction",
        quality_fn=lambda t: 1.0 if "A-9931" in t and "48.20" in t else 0.0,
        slider=3.0,  # cheap is fine for extraction
        rubric="Output must contain order id 'A-9931' and total '$48.20'.",
        expected="A-9931, $48.20",
    ),
    Task(
        label="retry-policy",
        prompt=("Write a retry policy with jitter for a flaky payment webhook. Justify the math."),
        task_type="reasoning",
        quality_fn=lambda t: 0.9 if len(t) > 200 else 0.4,
        slider=7.0,  # harder task, want quality
        rubric="Must describe exponential backoff with jitter and justify the math.",
    ),
    Task(
        label="binary-search",
        prompt="Implement binary search in Python with a test. Make it idiomatic.",
        task_type="code",
        quality_fn=lambda t: 1.0 if "def binary_search" in t and "assert" in t else 0.5,
        slider=5.0,
        rubric="Must define `def binary_search(...)` and include an `assert`-based test.",
    ),
]
