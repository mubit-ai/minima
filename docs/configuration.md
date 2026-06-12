# Configuration

All configuration is via environment variables, read from the process environment or a
local `.env` file (case-insensitive). The only **required** value is `MUBIT_API_KEY` (in
single-tenant mode). A complete annotated template ships as
[`.env.example`](../.env.example).

## Mubit memory backend

| Variable | Default | Notes |
|----------|---------|-------|
| `MUBIT_ENDPOINT` | `http://127.0.0.1:3000` | The Mubit runtime Minima reads/writes. |
| `MUBIT_API_KEY` | — | Mubit **data-plane** key. Required single-tenant; leave blank multi-tenant (resolved per org). |
| `MUBIT_TRANSPORT` | `auto` | `auto` \| `grpc` \| `http`. Use `http` for the local runtime (the gRPC `QueryMode` enum does not include `direct_bypass`, and auto may select gRPC). |
| `MUBIT_TIMEOUT_MS` | `30000` | Mubit client timeout. |

## Memory read path

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_MEMORY_RECALL_TIMEOUT_MS` | `2500` | Hard recall timeout; on breach, prior-only. Latency is embedder-bound (~100–300ms GPU, ~1.5s local CPU). |
| `MINIMA_MEMORY_RECALL_LIMIT` | `25` | Max neighbors recalled per request. |
| `MINIMA_RECALL_MODE` | `agent_routed` | `agent_routed` \| `direct_bypass` (faster but requires `enable_direct_search=true` on the Mubit instance — off by default on hosted Mubit). |
| `MINIMA_LANE_PREFIX` | `minima` | Lane prefix; lane = `<prefix>:<namespace or "default">`. |
| `MINIMA_SEED_LANE` | `minima:default` | Default lane for `minima-seed`. |

## Recommender tuning

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_TAU_MIN` | `0.55` | Quality threshold at slider 0. |
| `MINIMA_TAU_MAX` | `0.92` | Quality threshold at slider 10. |
| `MINIMA_BETA_PSEUDOCOUNT` | `2.5` | Beta-smoothing strength toward the capability prior. |
| `MINIMA_ESCALATION_W_MIN` | `1.5` | Escalate if total recalled weight is below this. |
| `MINIMA_ESCALATION_N_MIN` | `3` | Escalate if fewer than this many candidates have evidence. |
| `MINIMA_ESCALATION_C_MIN` | `0.45` | Escalate if recommended confidence is below this. |
| `MINIMA_ESCALATION_TIE_DELTA` | `0.05` | Escalate if top-2 scores are within this. |
| `MINIMA_DEFAULT_INPUT_TOKENS` | `1500` | Estimate fallback when the request omits expected input tokens. |
| `MINIMA_DEFAULT_OUTPUT_TOKENS` | `500` | Estimate fallback for expected output tokens. |
| `MINIMA_REFLECT_EVERY_N` | `25` | Trigger reflection every N feedbacks per lane. |
| `MINIMA_USE_OBSERVED_COST` | `true` | Rank by realized cost (observed/rescaled tiers) instead of a flat token estimate. |
| `MINIMA_OBSERVED_COST_MIN_N` | `3` | Min observations per candidate before the observed/rescaled tiers are trusted. |

See [Cost-basis tiers](concepts.md#cost-basis-tiers-estimate--observed--rescaled) for what
`MINIMA_USE_OBSERVED_COST` / `MIN_N` actually switch between.

## Cheap-LLM reasoner (escalation only)

Off by default. Requires the matching extra: `uv sync --extra reasoner-anthropic` and/or
`--extra reasoner-gemini`.

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_REASONER_PROVIDER` | `none` | `none` \| `anthropic` \| `gemini`. |
| `MINIMA_REASONER_MODEL` | — | Defaults per provider (Anthropic → `claude-haiku-4-5`). |
| `MINIMA_REASONER_TIMEOUT_MS` | `15000` | Per-attempt; the reasoner is the explicit slow tier. A real ranking call takes ~6–8s. |
| `MINIMA_REASONER_MAX_TOKENS` | `4096` | Output cap. Gemini 3.x reasons before emitting JSON; a small cap truncates it. |
| `MINIMA_REASONER_BLEND` | `0.5` | Weight on the LLM estimate vs the deterministic one. |
| `MINIMA_REASONER_CLASSIFY` | `true` | Let the reasoner refine ambiguous task classification. |
| `ANTHROPIC_API_KEY` | — | Required if provider is `anthropic`. |
| `GEMINI_API_KEY` | — | Required if provider is `gemini`. |

## Selection-bias correction (inverse propensity weighting)

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_IPW_ENABLED` | `true` | Re-weight aggregates by inverse logging propensity. |
| `MINIMA_IPW_CLIP_LOW` | `0.1` | Lower clip on the IPW factor. |
| `MINIMA_IPW_CLIP_HIGH` | `10.0` | Upper clip on the IPW factor. |

## Learning maturity

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_CLUSTER_GRANULARITY` | `coarse` | `coarse` = `task_type:difficulty`; `fine` appends a salient-keyword signature so distinct topics accumulate separately. |
| `MINIMA_CLUSTER_SIGNATURE_TOKENS` | `4` | Keywords in the `fine` signature. |
| `MINIMA_LESSON_ON_VERIFIED_PROD` | `true` | Promote a verified-prod strong success to a durable Lesson. |
| `MINIMA_LESSON_MIN_QUALITY` | `0.8` | Quality floor for lesson promotion. |
| `MINIMA_EXPLORATION_BONUS` | `0.0` | Optimistic bonus for under-explored candidates (0 = pure exploitation). |

## Catalog

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_CATALOG_REFRESH_SECONDS` | `21600` | Background price/capability refresh interval (6h). |
| `MINIMA_CATALOG_STALE_AFTER_SECONDS` | `86400` | Age beyond which prices are flagged stale (24h). |
| `MINIMA_LITELLM_PRICES_URL` | LiteLLM prices JSON | Primary price source. |
| `MINIMA_OPENROUTER_MODELS_URL` | OpenRouter models API | Caching flags + context windows. |
| `OPENROUTER_API_KEY` | — | Optional, for the OpenRouter source. |

## Service

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_HOST` | `0.0.0.0` | |
| `MINIMA_PORT` | `8080` | A local Mubit embedder often owns `:8080` — pick another if colliding. |
| `MINIMA_LOG_LEVEL` | `info` | |
| `MINIMA_RECOMMENDATION_STORE` | `memory` | `memory` \| `sqlite` (durable across restarts) \| `redis`. |
| `MINIMA_RECOMMENDATION_TTL_SECONDS` | `86400` | How long a `recommendation_id` stays resolvable for feedback. |
| `MINIMA_SQLITE_PATH` | `minima_state.db` | Backing file for the sqlite recstore + propensity. |

The recommendation store resolves a `recommendation_id` back to the recalled neighbors at
feedback time. `memory` is process-local (lost on restart); use `sqlite` to survive
restarts so in-flight recommendations can still receive feedback.

## Multi-tenancy

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_MULTITENANT` | `false` | `false` = single-tenant (env key = one "default" org). `true` = per-org Mubit instance resolved from a Minima key. |
| `MINIMA_PROVISIONING_KEY` | — | Admin credential to mint/manage tenant keys. Required (and never handed to callers) when multi-tenant. |
| `MINIMA_TENANT_STORE` | `memory` | `memory` \| `sqlite` (durable registry). |
| `MINIMA_TENANT_STORE_PATH` | `minima_tenants.db` | Backing file for the sqlite tenant store. |
| `MINIMA_TENANT_BOOTSTRAP_FILE` | — | Optional JSON seed for the in-memory tenant store (dev). |
| `MINIMA_DEFAULT_ORG_ID` | `default` | Org id used to partition single-tenant state. |

See **[Multi-Tenancy](multi-tenancy.md)** for the full setup.
