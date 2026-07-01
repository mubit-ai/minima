"""Harness configuration: where Minima lives, the candidate pool, and judge policy.

Defaults target the **hosted** Minima (``https://api.minima.sh``) so a freshly installed
``minima`` works out of the box — set ``MUBIT_API_KEY`` (routing auth) and a provider key
and routing just works. For local development against ``make run`` on :8080, set
``MINIMA_URL=http://localhost:8080`` (the repo's ``.env.harness`` does this explicitly).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# The hosted service is the product default. Local dev sets MINIMA_URL explicitly.
DEFAULT_MINIMA_URL = "https://api.minima.sh"
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
    # True when the user explicitly pinned a single model via /model: routing is bypassed and
    # that model (candidates[0]) runs directly. Distinct from "candidates happens to be length
    # 1" (which can occur from key-gating) — only an explicit pin skips Minima.
    pinned: bool = False
    # Memory isolation lane (-> namespace). None = default lane.
    namespace: str | None = None
    # cost/quality slider: 0=cheapest acceptable, 10=highest quality.
    cost_quality_tradeoff: float = 5.0
    # Independent grader model (different provider avoids self-grading bias).
    judge_model: str = DEFAULT_JUDGE_MODEL
    # Judge every Nth terminal turn (1 = every turn). 0 disables judging.
    judge_every: int = 1
    baseline_model_id: str | None = None
    # Minima HTTP timeout (s). Cold-start recommend can take >10s when Minima consults its
    # LLM reasoner (thin evidence), so a tight timeout silently degrades to OFFLINE routing.
    # 30s comfortably covers reasoner + recall. Override with MINIMA_TIMEOUT.
    timeout: float = 30.0
    # When True, an unreachable Minima falls back to a fixed default model instead of
    # raising. Keeps ad-hoc runs working without a Minima instance.
    allow_offline: bool = True
    # Semantic response cache (/cache): a near-duplicate prompt returns a prior answer for
    # free. Off by default — a too-loose threshold risks stale hits, and coding prompts are
    # mostly unique. threshold is the min similarity for a hit.
    cache_enabled: bool = False
    cache_threshold: float = 0.95

    @classmethod
    def from_env(cls, **overrides: object) -> HarnessConfig:
        cfg = cls()
        cfg.refresh_routing_env()
        timeout_env = os.environ.get("MINIMA_TIMEOUT")
        if timeout_env:
            try:
                cfg.timeout = float(timeout_env)
            except ValueError:
                pass
        for key, value in overrides.items():
            setattr(cfg, key, value)
        return cfg

    def refresh_routing_env(self) -> None:
        """Re-read just the Minima endpoint + routing auth from the environment, in place.

        Used when a key/URL is set via the ``/config`` overlay mid-session: those land in
        ``os.environ`` but this dataclass (and the live Minima client built from it) were
        captured at startup. Refreshing here lets ``/reconnect`` rebuild a working client
        without a restart. Leaves the candidate pool, namespace, judge policy, etc. untouched.
        """
        self.minima_url = os.environ.get("MINIMA_URL", self.minima_url)
        self.minima_api_key = os.environ.get("MINIMA_API_KEY") or os.environ.get("MUBIT_API_KEY")
        self.baseline_model_id = os.environ.get("MINIMA_BASELINE_MODEL_ID", self.baseline_model_id)
