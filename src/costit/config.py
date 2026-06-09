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
    costit_memory_recall_timeout_ms: int = 2500
    costit_memory_recall_limit: int = 25
    costit_recall_mode: str = "direct_bypass"  # direct_bypass (retrieval-only) | agent_routed
    costit_lane_prefix: str = "costit"
    costit_seed_lane: str = "costit:default"

    # --- Recommender tuning ---
    costit_tau_min: float = 0.55
    costit_tau_max: float = 0.92
    costit_beta_pseudocount: float = 2.5
    costit_escalation_w_min: float = 1.5
    costit_escalation_n_min: int = 3
    costit_escalation_c_min: float = 0.45
    costit_escalation_tie_delta: float = 0.05
    costit_default_input_tokens: int = 1500
    costit_default_output_tokens: int = 500
    costit_reflect_every_n: int = 25

    # --- Cheap-LLM reasoner (recommend-only) ---
    costit_reasoner_provider: str = "none"  # none | anthropic | gemini
    costit_reasoner_model: str | None = None  # default per provider (anthropic -> claude-haiku-4-5)
    # The reasoner is the explicit slow tier (only consulted on escalation): a real
    # ranking call with structured output takes ~6-8s, so a tight budget makes it time
    # out and silently degrade. This is per-attempt; it never touches the caller's own
    # LLM call (Costit adds zero latency there).
    costit_reasoner_timeout_ms: int = 15_000
    # A hard output cap (the reasoner stops early when done). Gemini 3.x "flash" spends
    # output tokens on internal reasoning before emitting the JSON, so a small cap
    # truncates the structured response — keep headroom. Anthropic forced-tool-use is
    # compact and won't approach this.
    costit_reasoner_max_tokens: int = 4096
    costit_reasoner_blend: float = 0.5  # weight on the LLM estimate vs the deterministic one
    costit_reasoner_classify: bool = True  # let the reasoner refine ambiguous task classification
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None

    # --- Selection-bias correction (inverse propensity weighting) ---
    costit_ipw_enabled: bool = True
    costit_ipw_clip_low: float = 0.1
    costit_ipw_clip_high: float = 10.0

    # --- Learning maturity ---
    # Cluster granularity controls the upsert grouping (one durable record per cluster+model).
    # "coarse" = task_type:difficulty; "fine" appends a salient-keyword signature bucket so
    # topically-distinct tasks of the same type/difficulty accumulate separately.
    costit_cluster_granularity: str = "coarse"  # coarse | fine
    costit_cluster_signature_tokens: int = 4
    # Promote a verified-in-production strong success to a durable Lesson (feeds reflect()).
    costit_lesson_on_verified_prod: bool = True
    costit_lesson_min_quality: float = 0.8
    # Optimistic exploration bonus added to under-explored candidates' predicted success,
    # scaled by their uncertainty. 0.0 = off (no exploration; pure exploitation).
    costit_exploration_bonus: float = 0.0

    # --- Catalog ---
    costit_catalog_refresh_seconds: int = 21_600
    costit_catalog_stale_after_seconds: int = 86_400
    costit_litellm_prices_url: str = (
        "https://raw.githubusercontent.com/BerriAI/litellm/main/"
        "model_prices_and_context_window.json"
    )
    costit_openrouter_models_url: str = "https://openrouter.ai/api/v1/models"
    openrouter_api_key: str | None = None

    # --- Service ---
    costit_host: str = "0.0.0.0"
    costit_port: int = 8080
    costit_log_level: str = "info"
    costit_recommendation_store: str = "memory"  # memory | sqlite | redis
    costit_recommendation_ttl_seconds: int = 86_400
    costit_sqlite_path: str = "costit_state.db"  # durable recstore + propensity backing file

    # --- Multi-tenancy (T3: hosted, per-org Mubit instance) ---
    # OFF by default => single-tenant: the env Mubit key above is the one "default" org
    # (this is also the self-hosted/T1 mode). ON => each org provides its own Mubit
    # instance once at onboarding; a Costit-issued key (cstk_<org>_<keyid>_<secret>)
    # resolves server-side to that instance. The org's Mubit key is never sent per call.
    costit_multitenant: bool = False
    # Admin credential used ONLY to mint/manage tenant keys (sent as X-Costit-Provisioning-Key).
    # Never handed to callers. Required for the /v1/admin/tenants endpoints to be usable.
    costit_provisioning_key: str | None = None
    costit_tenant_store: str = "memory"  # memory | sqlite
    costit_tenant_store_path: str = "costit_tenants.db"
    # Optional JSON file ([{org_id, mubit_endpoint, mubit_api_key_ref, ...}]) to seed the
    # in-memory tenant store at startup (dev/bootstrap; production should provision via API).
    costit_tenant_bootstrap_file: str | None = None
    costit_default_org_id: str = "default"  # org id used for single-tenant state partitioning

    @property
    def reasoner_enabled(self) -> bool:
        return self.costit_reasoner_provider.lower() not in ("", "none")

    def lane(self, namespace: str | None) -> str:
        return f"{self.costit_lane_prefix}:{namespace or 'default'}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
