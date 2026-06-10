"""
MuBit Learn Configuration.
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class LearnConfig:
    """Configuration for the mubit.learn module."""

    # Connection
    api_key: Optional[str] = None
    endpoint: Optional[str] = None

    # Identity
    agent_id: str = "auto"
    user_id: str = ""
    session_id: Optional[str] = None  # None = auto-generate UUID

    # Lesson injection
    inject_lessons: bool = True
    injection_position: str = "system"  # "system" | "prepend" | "last_system"
    max_token_budget: int = 2048
    entry_types: Optional[List[str]] = None  # None = server default
    context_sections: Optional[List[str]] = None
    # When True, mental_model entries are included in context retrieval
    # with highest priority. Mental models are curated summaries that
    # provide the most authoritative answers for entity-related queries.
    include_mental_models: bool = True

    # Lane scoping
    lane: str = ""
    auto_extract: bool = True
    extraction_mode: str = "heuristic"

    # Ingestion (pass-through to auto module)
    capture: str = "all"  # "all" | "input_only" | "output_only"
    min_length: int = 0

    # Run lifecycle
    auto_reflect: bool = True
    reflect_after_n_calls: Optional[int] = None

    # Cache
    cache_ttl_seconds: float = 30.0
    cache_max_entries: int = 100

    # Timeouts (seconds)
    # Pre-LLM lesson-injection timeout (hot path). Must exceed the server's
    # context-assembly latency or injection silently no-ops under fail_open; a
    # real /v2/control/context call takes ~2.5s, so 1.5s was too aggressive.
    # 5.0s gives headroom while staying a bounded hot-path budget; override via
    # init(context_fetch_timeout=...) or MUBIT_LEARN_CONTEXT_TIMEOUT.
    context_fetch_timeout: float = 5.0  # pre-LLM lesson injection timeout (hot path)
    # Recall-for-attribution timeout. This path (get_context_with_ids) runs
    # post-hoc to credit recalled entries with a call's outcome — it is not on
    # the latency-critical injection hot path, so it tolerates a longer wait
    # than context_fetch_timeout. Too short here silently yields empty IDs and
    # auto-attribution becomes a no-op.
    attribution_context_timeout: float = 8.0
    reflect_timeout: float = 10.0  # reflection timeout (background, can be longer)

    # Safety
    fail_open: bool = True  # if get_context() fails, proceed without lessons

    def resolve(self) -> "LearnConfig":
        """Resolve env var fallbacks for api_key and endpoint."""
        if self.api_key is None:
            self.api_key = os.environ.get("MUBIT_API_KEY", "")
        if self.endpoint is None:
            self.endpoint = os.environ.get(
                "MUBIT_ENDPOINT", "http://127.0.0.1:3000"
            )
        self.endpoint = self.endpoint.rstrip("/")
        env_attr = os.environ.get("MUBIT_LEARN_ATTRIBUTION_TIMEOUT")
        if env_attr:
            try:
                self.attribution_context_timeout = float(env_attr)
            except ValueError:
                pass
        env_ctx = os.environ.get("MUBIT_LEARN_CONTEXT_TIMEOUT")
        if env_ctx:
            try:
                self.context_fetch_timeout = float(env_ctx)
            except ValueError:
                pass
        return self
