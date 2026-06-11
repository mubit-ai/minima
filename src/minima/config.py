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
    # Request per-evidence score breakdowns (ExplainInfo) and log them. Diagnostic;
    # adds payload weight, keep off in prod unless investigating recall quality.
    minima_recall_explain: bool = False

    # --- Recommender tuning ---
    minima_tau_min: float = 0.55
    minima_tau_max: float = 0.92
    minima_beta_pseudocount: float = 2.5
    minima_escalation_w_min: float = 1.5
    minima_escalation_n_min: int = 3
    minima_escalation_c_min: float = 0.45
    minima_escalation_tie_delta: float = 0.05
    # Escalation trigger mode. "legacy" = the four independent heuristics. "uncertainty"
    # replaces thin_evidence + low_confidence with a single posterior-interval-width gate
    # on the recommended candidate (conflict stays as a hard override; tie is kept — it
    # captures rank instability the interval doesn't). Shadow "uncertainty" before
    # switching the default.
    minima_escalation_mode: str = "legacy"  # legacy | uncertainty
    minima_escalation_interval_width: float = 0.25
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
    # Adaptive blend: weight the LLM estimate by how thin the deterministic evidence is
    # (blend = blend_max * (1 - confidence), clamped to [0.1, 0.9]) instead of the fixed
    # minima_reasoner_blend. Heavy evidence barely moves; cold candidates lean on the LLM.
    minima_reasoner_blend_adaptive: bool = True
    minima_reasoner_blend_max: float = 0.8
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
    # 7 days: feedback often arrives well after the recommendation (batch evals, prod
    # verification). Past the TTL the late-feedback degraded path still accepts the
    # outcome (without neighbor attribution) via the decision log.
    minima_recommendation_ttl_seconds: int = 604_800
    minima_sqlite_path: str = "minima_state.db"  # durable recstore + propensity backing file
    # Accept feedback whose recommendation_id has expired from the recstore by falling
    # back to the decision log: the outcome record is still written (the durable
    # (cluster, model) upsert), but neighbor attribution and lesson promotion are skipped.
    minima_late_feedback_enabled: bool = True

    # --- Decision logging & off-policy evaluation ---
    # Every recommendation is logged (candidate set, propensity vector, tau, baselines)
    # and reconciled with realized outcomes at feedback time. This powers /v1/savings,
    # /v1/calibration, feedback-coverage, and offline policy evaluation.
    minima_decision_log_retention_days: int = 90
    # Orgs (comma-separated) that opt into epsilon-stochastic selection: with probability
    # epsilon the pick is sampled from a softmax over the tau-ELIGIBLE candidates instead
    # of the strict cheapest-eligible. Makes logged propensities non-degenerate so IPW and
    # off-policy evaluation are valid. Default: nobody (deterministic argmin everywhere).
    minima_epsilon_selection_orgs: str = ""
    minima_epsilon: float = 0.03
    minima_epsilon_softmax_temperature: float = 0.1

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

    # --- Durable-record fast path ---
    # Dereference the durable (cluster, model) outcome records alongside ANN recall so the
    # highest-signal evidence is always present regardless of embedding noise.
    #   off    — disabled entirely (no Dereference calls)
    #   shadow — fetch and log what ANN missed, but do NOT merge into scoring
    #   on     — merge dereferenced records into the evidence set
    minima_durable_fastpath: str = "off"  # off | shadow | on
    minima_durable_fastpath_max_refs: int = 8

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
