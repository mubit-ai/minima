"""minima_harness.minima — the routing/judging integration layer.

Wires the ported agent runtime to Minima: each ``MinimaAgent.prompt`` recommends a model,
runs the turn, judges quality, and feeds the realized tokens/cost/latency back so Minima's
memory sharpens (recommend -> run -> judge -> feedback).
"""

from minima_harness.minima.config import DEFAULT_CANDIDATES, HarnessConfig
from minima_harness.minima.judge import (
    ConstJudge,
    DeterministicJudge,
    LLMJudge,
    QualityJudge,
)
from minima_harness.minima.mapping import ModelMapping
from minima_harness.minima.router import MinimaRouter, RoutingResult
from minima_harness.minima.runtime import MinimaAgent

__all__ = [
    "ConstJudge",
    "DEFAULT_CANDIDATES",
    "DeterministicJudge",
    "HarnessConfig",
    "LLMJudge",
    "MinimaAgent",
    "MinimaRouter",
    "ModelMapping",
    "QualityJudge",
    "RoutingResult",
]
