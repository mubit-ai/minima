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
    # direct_bypass is faster but requires enable_direct_search=true on the Mubit instance
    # (off by default on hosted api.mubit.ai). agent_routed works on all instance types.
    minima_recall_mode: str = "agent_routed"  # agent_routed | direct_bypass
    minima_lane_prefix: str = "minima"
    minima_seed_lane: str = "minima:default"
    # LTM entry-type filter on recall. Minima evidence lives under exactly two types
    # (seeds ingest as "fact", feedback as "observation"); filtering at the server keeps
    # traces/lessons/etc. out of the candidate pool. Empty string = no filter (legacy).
    minima_recall_entry_types: str = "fact,observation"
    # Server-side ranking strategy: "relevance" | "freshness" | "balanced" | "" (omit).
    # "balanced" lets recency influence WHICH neighbors are retrieved; how much each
    # neighbor then counts is the client-side age decay (see evidence half-life below) —
    # "freshness" on top of that decay would double-discount old evidence.
    minima_recall_rank_by: str = "balanced"
    # Hard recency window: only recall evidence from the last N days (0 = no window).
    minima_recall_max_age_days: int = 0
    # Mubit search budget tier: "low" | "mid" | "high" ("" = server default).
    minima_recall_budget: str = "mid"
    # Fraction of recalls (0..1) that request Mubit's per-evidence fusion-score
    # breakdown (explain) and log it as `recall_explain` — retrieval observability
    # for calibration debugging. 0 disables; the extra response payload is the cost.
    minima_recall_explain_sample: float = 0.0

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
    # Evidence age decay: each recalled outcome's weight halves every half-life. Replaces
    # the old binary stale 0.5x for records that carry a recorded_at timestamp; supersession
    # (is_stale) still caps the multiplier at 0.5. knowledge_confidence is deliberately NOT
    # touched — its server-side recency component reflects *reinforcement* recency, while
    # this decay reflects *observation* age (distinct signals; multiplying both is intended,
    # adding extra recency factors on top is not).
    minima_evidence_half_life_days: float = 30.0
    minima_evidence_decay_floor: float = 0.1
    # Recall-track (free quality labels): once a record has this many recall votes, its
    # aggregation weight is scaled by its recall success rate (floored — see aggregate),
    # and a rate below minima_recall_invalidate_rate stamps invalidated_at (bi-temporal
    # tombstone; the record vanishes from ranking but stays readable). 0 disables both.
    minima_recall_vote_min_n: int = 5
    minima_recall_invalidate_rate: float = 0.2
    # Seed-vs-live weighting: seeded outcomes (source_dataset set) count at this weight,
    # decaying linearly to zero once a model has crowdout_n live outcomes in the recalled
    # set — live evidence replaces the bootstrap instead of competing with it forever.
    minima_seed_weight: float = 0.5
    minima_seed_crowdout_n: int = 5
    # Latency-aware ranking: annotate candidates with a robust observed latency percentile
    # and enforce Constraints.max_latency_ms against it (only for candidates with at least
    # min_n latency observations — a model is never excluded without evidence).
    minima_latency_percentile: float = 0.75
    minima_latency_min_n: int = 3
    # Default-output-token multipliers by classified difficulty, applied when the caller
    # does not supply expected_output_tokens (affects the "estimate" cost basis only).
    minima_difficulty_output_multipliers: dict[str, float] = {
        "trivial": 0.5,
        "easy": 0.75,
        "medium": 1.0,
        "hard": 1.5,
        "expert": 2.0,
    }

    # --- Learning maturity ---
    # Promote a verified-in-production strong success to a durable Lesson (feeds reflect()).
    minima_lesson_on_verified_prod: bool = True
    minima_lesson_min_quality: float = 0.8

    # --- Catalog ---
    minima_catalog_refresh_seconds: int = 21_600
    minima_catalog_stale_after_seconds: int = 86_400
    minima_litellm_prices_url: str = (
        "https://raw.githubusercontent.com/BerriAI/litellm/main/"
        "model_prices_and_context_window.json"
    )
    minima_openrouter_models_url: str = "https://openrouter.ai/api/v1/models"

    # --- Service ---
    minima_host: str = "0.0.0.0"
    minima_port: int = 8080
    minima_log_level: str = "info"
    # memory | sqlite | cloudsql — controls DecisionLog, Propensity, and (unless
    # MINIMA_RECSTORE_BACKEND overrides) RecStore + DurableRefs.
    minima_recommendation_store: str = "memory"
    # 7 days: feedback often arrives well after the recommendation (batch evals, prod
    # verification). Past the TTL the late-feedback degraded path still accepts the
    # outcome (without neighbor attribution) via the decision log.
    minima_recommendation_ttl_seconds: int = 604_800
    minima_sqlite_path: str = "minima_state.db"  # durable recstore + propensity backing file

    # --- Persistent store backends (Cloud SQL + Redis) ---
    # PostgreSQL DSN for DecisionLog, Propensity, and optionally RecStore + DurableRefs.
    # Cloud Run format: postgresql://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
    minima_database_url: str | None = None
    # Redis URL for RecStore + DurableRefs when MINIMA_RECSTORE_BACKEND=redis.
    minima_redis_url: str = "redis://localhost:6379/0"
    # Backend override for RecStore + DurableRefs only (memory | sqlite | cloudsql | redis).
    # Empty string means inherit from MINIMA_RECOMMENDATION_STORE.
    minima_recstore_backend: str = ""
    # Accept feedback whose recommendation_id has expired from the recstore by falling
    # back to the decision log: the outcome record is still written (the durable
    # (cluster, model) upsert), but neighbor attribution and lesson promotion are skipped.
    minima_late_feedback_enabled: bool = True

    # --- Decision logging & off-policy evaluation ---
    # Every recommendation is logged (candidate set, propensity vector, tau, baselines)
    # and reconciled with realized outcomes at feedback time. This powers /v1/savings,
    # /v1/calibration, feedback-coverage, and offline policy evaluation.
    minima_decision_log_retention_days: int = 90
    # Selection policy: "thompson" (default) samples theta_m ~ Beta(alpha_m, beta_m) per
    # decision and picks the cheapest model clearing tau under the sample. Self-tuning
    # exploration: well-evidenced candidates behave like argmin; uncertain ones get tried
    # in proportion to how plausible it is that they're good — and the Monte-Carlo
    # selection frequencies are the logged propensities, so off-policy evaluation is
    # valid. "argmin" = deterministic cheapest-clearing-tau (degenerate propensities).
    minima_selection_policy: str = "thompson"  # thompson | argmin
    # Orgs (comma-separated) that opt OUT of Thompson back to deterministic argmin.
    minima_argmin_orgs: str = ""
    minima_thompson_samples: int = 128
    # Cap on the running share of decisions where Thompson deviates from the argmin pick
    # (per org, per process). Above the cap the argmin pick is used (with degenerate
    # propensities and an explore_budget_capped warning) — bounds deliberate-exploration
    # spend on live traffic. 1.0 = uncapped.
    minima_explore_share_cap: float = 0.25

    # --- Calibration monitoring ---
    minima_calibration_window_days: int = 30
    minima_calibration_shrinkage_k: float = 20.0
    minima_calibration_bins: int = 10
    # CUSUM slack/threshold sized for BINARY residuals: a single failure on a 0.8
    # prediction is a 0.8 residual, so the slack must absorb routine noise (k ~ 0.5
    # sigma ~ 0.25) and the threshold must require a sustained run (h ~ 4-5 sigma).
    # Smaller values flag every healthy stream.
    minima_cusum_k: float = 0.25
    minima_cusum_h: float = 2.0

    # --- Calibration APPLY (remap predicted_success before the tau decision) ---
    # The monitoring above MEASURES calibration; these control whether a fitted isotonic
    # remap is actually applied so predicted_success is a truthful probability. Safe by
    # construction: with < min_n reconciled outcomes the fit returns identity (no-op), and
    # each slice shrinks toward identity by n/(n+shrinkage_k). Reuses the calibration
    # window + shrinkage_k above. Refit is lazy and cached per Recommender (org).
    minima_calibration_apply: bool = True
    minima_calibration_min_n: int = 30
    minima_calibration_refresh_seconds: int = 600

    # --- Cache-aware cost ---
    # Fraction of the INCUMBENT model's input priced at its cache-read rate on the
    # estimate basis (the session's prompt cache survives only if the model doesn't
    # change). 0 disables incumbent stickiness.
    minima_incumbent_cache_fraction: float = 0.7

    # --- Neighbor-vote classification ---
    # When the heuristic classifier returns `other`, disambiguate the task_type from the
    # ANN-recalled semantic neighbors' types (free + semantic) instead of (or before) a paid
    # LLM-classify call. Embedding-based routing already happens via recall; this just makes
    # the cluster KEY semantically coherent for ambiguous prompts.
    minima_neighbor_classify: bool = True

    # --- Multi-tenancy (T3: hosted, per-org Mubit instance) ---
    # org id used for state partitioning (recstore / propensity) in single-key mode
    minima_default_org_id: str = "default"

    def lane(self, namespace: str | None) -> str:
        return f"{self.minima_lane_prefix}:{namespace or 'default'}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
