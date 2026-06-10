"""Environment-driven configuration.

Every setting is read from an environment variable with the same (case-insensitive)
name, optionally from a local ``.env`` file. The only required value is ``MUBIT_API_KEY``.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Mubit memory backend ---
    mubit_endpoint: str = "http://127.0.0.1:3000"
    mubit_api_key: str | None = None
    mubit_transport: str = "auto"  # auto | grpc | http
    mubit_timeout_ms: int = 30_000

    # --- Memory read path ---
    minima_memory_recall_timeout_ms: int = 2500
    minima_memory_recall_limit: int = 25
    minima_recall_mode: str = "direct_bypass"  # direct_bypass (retrieval-only) | agent_routed
    minima_lane_prefix: str = "minima"
    minima_seed_lane: str = "minima:default"

    # --- Recommender tuning ---
    minima_tau_min: float = 0.55
    minima_tau_max: float = 0.92
    minima_beta_pseudocount: float = 2.5
    minima_escalation_w_min: float = 1.5
    minima_escalation_n_min: int = 3
    minima_escalation_c_min: float = 0.45
    minima_escalation_tie_delta: float = 0.05
    minima_default_input_tokens: int = 1500
    minima_default_output_tokens: int = 500
    minima_reflect_every_n: int = 25
    # Rank eligible models by OBSERVED avg $/call from recalled outcomes (Mubit stores
    # cost_usd per outcome) instead of a flat token estimate. The estimate assumes a fixed
    # completion length and so ignores reasoning/thinking tokens, which can mis-rank a
    # cheap-listed model that is expensive in practice (e.g. a "flash" model that spends
    # heavily on internal reasoning). Falls back to the estimate when fewer than
    # minima_observed_cost_min_n cost observations exist for the candidate.
    minima_use_observed_cost: bool = True
    minima_observed_cost_min_n: int = 3

    # --- Cheap-LLM reasoner (recommend-only) ---
    minima_reasoner_provider: str = "none"  # none | anthropic | gemini
    minima_reasoner_model: str | None = None  # default per provider (anthropic -> claude-haiku-4-5)
    # The reasoner is the explicit slow tier (only consulted on escalation): a real
    # ranking call with structured output takes ~6-8s, so a tight budget makes it time
    # out and silently degrade. This is per-attempt; it never touches the caller's own
    # LLM call (Minima adds zero latency there).
    minima_reasoner_timeout_ms: int = 15_000
    # A hard output cap (the reasoner stops early when done). Gemini 3.x "flash" spends
    # output tokens on internal reasoning before emitting the JSON, so a small cap
    # truncates the structured response — keep headroom. Anthropic forced-tool-use is
    # compact and won't approach this.
    minima_reasoner_max_tokens: int = 4096
    minima_reasoner_blend: float = 0.5  # weight on the LLM estimate vs the deterministic one
    minima_reasoner_classify: bool = True  # let the reasoner refine ambiguous task classification
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None

    # --- Selection-bias correction (inverse propensity weighting) ---
    minima_ipw_enabled: bool = True
    minima_ipw_clip_low: float = 0.1
    minima_ipw_clip_high: float = 10.0

    # --- Learning maturity ---
    # Cluster granularity controls the upsert grouping (one durable record per cluster+model).
    # "coarse" = task_type:difficulty; "fine" appends a salient-keyword signature bucket so
    # topically-distinct tasks of the same type/difficulty accumulate separately.
    minima_cluster_granularity: str = "coarse"  # coarse | fine
    minima_cluster_signature_tokens: int = 4
    # Promote a verified-in-production strong success to a durable Lesson (feeds reflect()).
    minima_lesson_on_verified_prod: bool = True
    minima_lesson_min_quality: float = 0.8
    # Optimistic exploration bonus added to under-explored candidates' predicted success,
    # scaled by their uncertainty. 0.0 = off (no exploration; pure exploitation).
    minima_exploration_bonus: float = 0.0

    # --- Catalog ---
    minima_catalog_refresh_seconds: int = 21_600
    minima_catalog_stale_after_seconds: int = 86_400
    minima_litellm_prices_url: str = (
        "https://raw.githubusercontent.com/BerriAI/litellm/main/"
        "model_prices_and_context_window.json"
    )
    minima_openrouter_models_url: str = "https://openrouter.ai/api/v1/models"
    openrouter_api_key: str | None = None

    # --- Service ---
    minima_host: str = "0.0.0.0"
    minima_port: int = 8080
    minima_log_level: str = "info"
    minima_recommendation_store: str = "memory"  # memory | sqlite | redis
    minima_recommendation_ttl_seconds: int = 86_400
    minima_sqlite_path: str = "minima_state.db"  # durable recstore + propensity backing file

    # --- Multi-tenancy (T3: hosted, per-org Mubit instance) ---
    # org id used for state partitioning (recstore / propensity) in single-key mode
    minima_default_org_id: str = "default"

    @property
    def reasoner_enabled(self) -> bool:
        return self.minima_reasoner_provider.lower() not in ("", "none")

    def lane(self, namespace: str | None) -> str:
        return f"{self.minima_lane_prefix}:{namespace or 'default'}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
