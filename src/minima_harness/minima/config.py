"""Harness configuration: where Minima lives, the candidate pool, and judge policy.

Defaults target a local Minima (``make run`` on :8080) so the harness works out of the
box against a dev instance. Point ``MINIMA_URL`` at ``https://api.minima.sh`` (and set
``MINIMA_API_KEY`` to your Mubit key) for the hosted service.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_MINIMA_URL = "http://localhost:8080"
DEFAULT_JUDGE_MODEL = "claude-haiku-4-5"

# Candidate set mirrors examples/agent_warmup.py so cold-start routing behaves the same.
DEFAULT_CANDIDATES: list[str] = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]


@dataclass(slots=True)
class HarnessConfig:
    """Routing + judging policy for a :class:`MinimaAgent` run."""

    minima_url: str = DEFAULT_MINIMA_URL
    minima_api_key: str | None = None
    # Model ids Minima is allowed to pick from (-> Constraints.candidate_models).
    candidates: list[str] = field(default_factory=lambda: list(DEFAULT_CANDIDATES))
    # Memory isolation lane (-> namespace). None = default lane.
    namespace: str | None = None
    # cost/quality slider: 0=cheapest acceptable, 10=highest quality.
    cost_quality_tradeoff: float = 5.0
    # Independent grader model (different provider avoids self-grading bias).
    judge_model: str = DEFAULT_JUDGE_MODEL
    # Judge every Nth terminal turn (1 = every turn). 0 disables judging.
    judge_every: int = 1
    baseline_model_id: str | None = None
    timeout: float = 10.0
    # When True, an unreachable Minima falls back to a fixed default model instead of
    # raising. Keeps ad-hoc runs working without a Minima instance.
    allow_offline: bool = True

    @classmethod
    def from_env(cls, **overrides: object) -> HarnessConfig:
        cfg = cls()
        cfg.minima_url = os.environ.get("MINIMA_URL", cfg.minima_url)
        cfg.minima_api_key = os.environ.get("MINIMA_API_KEY") or os.environ.get("MUBIT_API_KEY")
        for key, value in overrides.items():
            setattr(cfg, key, value)
        return cfg
