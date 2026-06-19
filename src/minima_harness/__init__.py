"""minima_harness — a lean Python port of @earendil-works/pi's agent harness, made
Minima-native (routes each turn through Minima's recommender and feeds outcomes back).

Phase 0 ships the unified LLM API surface (``minima_harness.ai``), the task corpus
(``minima_harness.tasks``), and harness config (``minima_harness.minima.HarnessConfig``).
The ported agent runtime and the Minima router land in later phases.

Derived from the MIT-licensed @earendil-works/pi (see LICENSE_PI).
"""

from minima_harness import ai, minima, tasks
from minima_harness.minima.config import HarnessConfig

__version__ = "0.1.0"

__all__ = ["HarnessConfig", "__version__", "ai", "minima", "tasks"]
