# Configuration

All configuration is via environment variables, read from the process environment or a
local `.env` file (case-insensitive). The only **required** value is `MUBIT_API_KEY` (in
single-tenant mode). A complete annotated template ships as
[`.env.example`](../.env.example).

> This page covers the **server** (`src/minima/`). The `minima` CLI/TUI harness has its own
> flag set — see [Harness Architecture § Key environment
> flags](harness-architecture.md#key-environment-flags).

## Mubit memory backend

| Variable | Default | Notes |
|----------|---------|-------|
| `MUBIT_ENDPOINT` | `http://127.0.0.1:3000` | The Mubit runtime Minima reads/writes. |
| `MUBIT_API_KEY` | — | Mubit **data-plane** key — the server-side fallback credential when a request carries no bearer token. Callers may instead pass their own Mubit key per request (pass-through auth). |
| `MUBIT_TRANSPORT` | `auto` | `auto` \| `grpc` \| `http`. Use `http` for the local runtime (the gRPC `QueryMode` enum does not include `direct_bypass`, and auto may select gRPC). |
| `MUBIT_TIMEOUT_MS` | `30000` | Mubit client timeout. |

## Memory read path

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_MEMORY_RECALL_TIMEOUT_MS` | `2500` | Hard recall timeout; on breach, prior-only. Latency is embedder-bound (~100–300ms GPU, ~1.5s local CPU). |
| `MINIMA_MEMORY_RECALL_LIMIT` | `25` | Max neighbors recalled per request. |
| `MINIMA_RECALL_MODE` | `agent_routed` | `agent_routed` \| `direct_bypass` (faster but requires `enable_direct_search=true` on the Mubit instance — off by default on hosted Mubit). |
| `MINIMA_RECALL_ENTRY_TYPES` | `fact,observation` | Server-side entry-type filter (seeds land as `fact`, feedback as `observation`). Empty = no filter. |
| `MINIMA_RECALL_RANK_BY` | `balanced` | Mubit fusion strategy: `relevance` \| `freshness` \| `balanced` (empty = server default). |
| `MINIMA_RECALL_BUDGET` | `mid` | Mubit search budget tier: `low` (<500ms) \| `mid` \| `high` (empty = server default). |
| `MINIMA_RECALL_MAX_AGE_DAYS` | `0` | Hard recency window on recall (`min_timestamp`); `0` = no window. |
| `MINIMA_RECALL_EXPLAIN_SAMPLE` | `0` | Fraction of recalls (0..1) that request + log Mubit's per-evidence fusion-score breakdown (`recall_explain` log lines). |
| `MINIMA_LANE_PREFIX` | `minima` | Lane prefix; lane = `<prefix>:<namespace or "default">`. |
| `MINIMA_SEED_LANE` | `minima:default` | Default lane for `minima-seed`. |

## Recommender tuning

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_TAU_MIN` | `0.55` | Quality threshold at slider 0. |
| `MINIMA_TAU_MAX` | `0.92` | Quality threshold at slider 10. |
| `MINIMA_BETA_PSEUDOCOUNT` | `2.5` | Beta-smoothing strength toward the capability prior. |
| `MINIMA_COLD_START_MARGIN` | `0.03` | Extra eligibility margin over tau for candidates with no memory evidence (pure catalog prior). Falls back to plain tau if it would empty the eligible set. |
| `MINIMA_HUMAN_EVIDENCE_WEIGHT` | `0.6` | Aggregation weight multiplier for caller-asserted (`human`) labels relative to gate/judge evidence (clamped 0–1). |
| `MINIMA_POSTERIOR_DISCOUNTING` | `false` | Opt-in: apply the non-stationarity discount and posterior-reset epochs to the LIVE pick. Off, they run shadow-only (the `discounted` challenger + OPE replay) and recommendations are unchanged. |
| `MINIMA_AGGREGATE_HALF_LIFE_DAYS` | `45` | Half-life of the non-stationarity discount (unfloored, on top of the floored evidence decay). Only affects the live pick when `MINIMA_POSTERIOR_DISCOUNTING` is on; `0` disables even then. |
| `MINIMA_NEIGHBOR_CLASSIFY` | `true` | Re-classify `other`/low-confidence tasks from the recalled neighbors' task types (free, no LLM). |
| `MINIMA_NEIGHBOR_CLASSIFY_CONFIDENCE` | `0.6` | Heuristic-confidence threshold below which neighbor votes may refine the classification (type + difficulty). Caller-supplied types always win. |
| `MINIMA_ESCALATION_W_MIN` | `1.5` | Escalate if total recalled weight is below this. |
| `MINIMA_ESCALATION_N_MIN` | `3` | Escalate if fewer than this many candidates have evidence. |
| `MINIMA_ESCALATION_C_MIN` | `0.45` | Escalate if recommended confidence is below this. |
| `MINIMA_ESCALATION_TIE_DELTA` | `0.05` | Escalate if top-2 scores are within this. |
| `MINIMA_DEFAULT_INPUT_TOKENS` | `1500` | Estimate fallback when the request omits expected input tokens. |
| `MINIMA_DEFAULT_OUTPUT_TOKENS` | `500` | Estimate fallback for expected output tokens. |
| `MINIMA_REFLECT_EVERY_N` | `25` | Trigger reflection every N feedbacks per lane. |
| `MINIMA_USE_OBSERVED_COST` | `true` | Rank by realized cost (observed/rescaled tiers) instead of a flat token estimate. |
| `MINIMA_OBSERVED_COST_MIN_N` | `3` | Min observations per candidate before the observed/rescaled tiers are trusted. |
| `MINIMA_RECALL_VOTE_MIN_N` | `5` | Recall-track: votes required before a record's aggregation weight scales with its recall success rate (floor 0.25). `0` disables the whole recall track. |
| `MINIMA_RECALL_INVALIDATE_RATE` | `0.2` | Recall success rate below which a record (with ≥ min-n votes) is stamped `invalidated_at` — out of ranking, still readable. |

See [Cost-basis tiers](concepts.md#cost-basis-tiers-estimate--observed--rescaled) for what
`MINIMA_USE_OBSERVED_COST` / `MIN_N` actually switch between.

## Task classifier

| Variable | Default | Notes |
|----------|---------|-------|
| `MINIMA_EMBED_CLASSIFIER` | `false` | Serve task types from the trained embedding classifier (regex fallback on abstention). The hosted service runs with this on; the artifact is baked into the Docker image. |
| `MINIMA_CLASSIFIER_ARTIFACT` | *(empty)* | Directory holding the trained artifact (`embeddings.npz` / `head.npz` / `tokenizer.json` / `manifest.json`). The image sets it to `/app/models/classifier/<classifier_id>`. Needs the `classifier` extra (`numpy` + `tokenizers`). |
| `MINIMA_CLASSIFIER_REQUIRED` | `false` | Fail loud: refuse to start when the classifier is enabled but the artifact is missing or broken, instead of silently degrading to regex. On in the hosted deploy. |
| `MINIMA_CLUSTER_KEY_VERSION` | `v1` | Version suffix written into new memory cluster keys. Bumped only by the key-space flip release, never by hand. |
| `MINIMA_CLUSTER_KEY_READ_VERSIONS` | *(empty)* | Comma-separated extra key versions to read during a migration window (e.g. `v2,v1`). Empty = read the write version only. |
| `MINIMA_DUAL_KEY_MIN_N` | `3` | Per-model active-version evidence count at which legacy-version evidence is dropped from the aggregate. |
| `MINIMA_LEGACY_EVIDENCE_WEIGHT` | `0.7` | Discount applied to legacy-version evidence while it is still consulted. |

The `/v1/health` response reports the active classifier (`classifier.id`,
`classifier.embed_loaded`, `classifier.required`); decision-log rows stamp
`classifier_id` per request, so mixed fleets are attributable during a rollout.


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

Nothing to configure: auth is pass-through, so any caller's `Authorization: Bearer mbt_…`
Mubit key selects (and scopes) its own org against the configured `MUBIT_ENDPOINT`.
`MUBIT_API_KEY` is only the fallback for requests that carry no key. See
**[Multi-Tenancy](multi-tenancy.md)**.
