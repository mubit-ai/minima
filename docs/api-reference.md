# API Reference

Base path: `/v1`. All request and response bodies are JSON. Interactive OpenAPI docs are
served at `/docs` when the service is running.

## Authentication

- **Single-tenant mode** (`MINIMA_MULTITENANT=false`, the default): no caller credential is
  required. Every request maps to the one org configured by the env Mubit key. Any
  `Authorization` header is ignored.
- **Multi-tenant mode** (`MINIMA_MULTITENANT=true`): callers must present
  `Authorization: Bearer mnim_<org>_<keyid>_<secret>`, which resolves server-side to that
  org's own Mubit instance. A missing or invalid key returns `401`. The admin/provisioning
  endpoints are guarded separately by the `X-Minima-Provisioning-Key` header. See
  **[Multi-Tenancy](multi-tenancy.md)**.

`user_id` and `namespace` are **within-org** scoping fields, not auth boundaries. The tenant
boundary is the Minima key → a Mubit instance.

## Errors

Errors are returned as `application/problem+json` (RFC 7807-style):

```json
{ "type": "about:blank", "title": "No candidate models", "status": 422,
  "detail": "no models match the supplied constraints" }
```

| Status | Title | When |
|--------|-------|------|
| `400` | Invalid request | Request body fails validation (`ValueError`). |
| `401` | Unauthorized | Multi-tenant: missing/invalid Minima key. |
| `403` | Forbidden | Admin endpoint: invalid/missing provisioning key. |
| `404` | Not Found | Admin endpoint called while multi-tenancy is disabled. |
| `409` | Conflict | Provisioning an `org_id` that already exists. |
| `422` | No candidate models | Constraints eliminated every catalog model. |

Note that `POST /v1/feedback` does **not** error on an unknown `recommendation_id`; it
returns `200` with `accepted: false` and an `unknown_recommendation` warning (so retried or
cross-org feedback fails safely).

---

## `POST /v1/recommend`

Recommend a model for a single task.

### Request — `RecommendRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `task` | `TaskInput` | required | The task to route (see below). |
| `cost_quality_tradeoff` | float `0–10` | `5.0` | 0 = cheapest acceptable, 10 = highest quality. Sets the quality threshold `τ`. |
| `constraints` | `Constraints` | `{}` | Hard limits on the candidate set (see below). |
| `user_id` | string \| null | `null` | Within-org actor label (not a tenant/auth boundary). Scopes recall. |
| `namespace` | string \| null | `null` | Within-org sub-scope (team/project/env). Maps to lane `minima:<namespace>`. |
| `max_candidates` | int `1–64` | `8` | Cap on candidates considered. |
| `allow_llm_escalation` | bool | `true` | Allow the cheap-LLM reasoner when evidence is thin (no effect if no reasoner configured). |
| `explain` | bool | `true` | Include `evidence[]` refs on each ranked model. |

**`TaskInput`**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `task` | string | required | Raw task/prompt text; embedded by Mubit for recall. |
| `task_type` | enum \| null | `null` | One of `code, summarization, extraction, qa, reasoning, classification, translation, creative, rag, tool_use, other`. Heuristic-classified if omitted. |
| `difficulty` | enum \| null | `null` | One of `trivial, easy, medium, hard, expert`. Heuristic-classified if omitted. |
| `expected_input_tokens` | int ≥ 0 \| null | `null` | Feeds the cost estimate; defaults to `MINIMA_DEFAULT_INPUT_TOKENS`. |
| `expected_output_tokens` | int ≥ 0 \| null | `null` | Feeds the cost estimate; defaults to `MINIMA_DEFAULT_OUTPUT_TOKENS`. |
| `tags` | string[] | `[]` | Propagated to Mubit `env_tags` (e.g. `lang:python`) for version-aware recall. |

**`Constraints`** (all optional; unset fields impose no limit)

| Field | Type | Notes |
|-------|------|-------|
| `allowed_providers` | string[] \| null | Whitelist by provider. |
| `candidate_models` | string[] \| null | Restrict to these model ids. |
| `excluded_models` | string[] \| null | Blacklist by model id. |
| `max_cost_per_call` | float ≥ 0 \| null | USD hard filter on estimated cost. Warns `no_model_within_cost_budget` if it eliminates all. |
| `min_quality` | float `0–1` \| null | Predicted-success floor; raises `τ`. |
| `require_prompt_caching` | bool | Keep only models that support prompt caching. |
| `max_latency_ms` | int > 0 \| null | Reserved latency hint. |
| `require_context_window` | int > 0 \| null | Keep only models with at least this context window. |

### Response — `RecommendResponse`

| Field | Type | Notes |
|-------|------|-------|
| `recommendation_id` | string | The handle you quote back to `POST /v1/feedback`. |
| `recommended_model` | `RankedModel` | The chosen model. |
| `ranked` | `RankedModel[]` | Every candidate, sorted by final score. |
| `fallback_model` | `RankedModel` \| null | A more reliable retry target. |
| `confidence` | float `0–1` | Overall confidence in the pick. |
| `decision_basis` | enum | `memory` \| `prior` \| `llm` — which path produced the pick. |
| `threshold_used` | float | The quality threshold `τ` applied. |
| `classified_task_type` | enum | Final task type used. |
| `classified_difficulty` | enum | Final difficulty used. |
| `catalog_version` | string | Catalog version that priced the candidates. |
| `catalog_stale` | bool | Prices older than the staleness window. |
| `latency_ms` | int | Minima-side recommendation latency. |
| `warnings` | string[] | See **Warnings** below. |

**`RankedModel`**

| Field | Type | Notes |
|-------|------|-------|
| `model_id` | string | |
| `provider` | string | |
| `predicted_success` | float `0–1` | Probability the model clears the task. |
| `est_cost_usd` | float ≥ 0 | Estimated cost for this request, per the chosen cost basis. |
| `est_cost_breakdown` | object | Keys depend on the basis: `{rescaled, obs_output_tokens}`, `{observed_avg}`, or `{input, output}`. See [Cost-basis tiers](concepts.md#cost-basis-tiers-estimate--observed--rescaled). |
| `score` | float | Final objective score; the sorting key. |
| `rationale` | string | Human-readable reason (tags cost as `obs` or `est`). |
| `decision_basis` | enum | Per-model basis: `memory` \| `prior` \| `llm`. |
| `evidence` | `EvidenceRef[]` | Recalled neighbors that informed this candidate (empty if `explain=false`). |
| `supports_prompt_caching` | bool | |
| `context_window` | int | |

**`EvidenceRef`**

| Field | Type | Notes |
|-------|------|-------|
| `entry_id` | string | Mubit `QueryEvidence.id` (used for outcome attribution). |
| `reference_id` | string \| null | Stable reference id. |
| `model_id` | string | The model this past outcome was about. |
| `score` | float | Retrieval similarity. |
| `knowledge_confidence` | float `0–1` | Mubit's reliability estimate for the entry. |
| `observed_success` | float `0–1` | The recorded quality of that past outcome. |
| `is_stale` | bool | Whether the entry is marked stale. |

### Warnings

| Warning | Meaning |
|---------|---------|
| `cold_start` | No recalled outcomes; prior-only. |
| `recall_timeout` | Mubit recall exceeded the timeout; prior-only. |
| `memory_unavailable` | Recall errored; prior-only. |
| `prices_stale` | Catalog prices older than the staleness window. |
| `no_model_meets_threshold` | No candidate cleared `τ`; recommended the highest-success one. |
| `no_model_within_cost_budget` | `max_cost_per_call` eliminated all; constraint relaxed for ranking. |
| `escalation_suggested:<reason>` | Escalation criteria met (`thin_evidence`, `low_confidence`, `tie`, …). |
| `reasoner_consulted` | The cheap-LLM reasoner was consulted and changed scores. |
| `reasoner_failed` | The reasoner errored or returned unusable output; deterministic result used. |
| `reasoner_disabled` | Escalation suggested but no reasoner is configured. |
| `llm_classified` | The reasoner refined an ambiguous task classification. |

### Example

```bash
curl -s http://localhost:8080/v1/recommend -H 'content-type: application/json' -d '{
  "task": {"task": "Write a Python function that merges k sorted linked lists.",
           "task_type": "code", "difficulty": "hard",
           "expected_input_tokens": 180, "expected_output_tokens": 600,
           "tags": ["lang:python"]},
  "cost_quality_tradeoff": 3,
  "constraints": {"min_quality": 0.8, "excluded_models": ["some-deprecated-model"]},
  "namespace": "team-payments"
}' | jq
```

---

## `POST /v1/recommend/workflow`

Recommend a model for each step of a multi-step workflow. Each step runs the same engine
independently and gets its own `recommendation_id` for per-step feedback.

### Request — `WorkflowRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `steps` | `WorkflowStep[]` | required (≥1) | The steps to route. |
| `cost_quality_tradeoff` | float `0–10` | `5.0` | Applied to every step. |
| `constraints` | `Constraints` | `{}` | Global constraints; each step may override. |
| `user_id` | string \| null | `null` | |
| `namespace` | string \| null | `null` | |
| `allow_llm_escalation` | bool | `true` | |

**`WorkflowStep`**

| Field | Type | Notes |
|-------|------|-------|
| `step_id` | string | Caller-defined id (echoed in the response). |
| `task` | `TaskInput` | The step's task. |
| `constraints` | `Constraints` \| null | Per-step override, **merged over** the global constraints. |
| `depends_on` | string[] | Declared dependencies (currently informational; steps are scored independently). |

### Response — `WorkflowResponse`

| Field | Type | Notes |
|-------|------|-------|
| `workflow_recommendation_id` | string | Id for the whole workflow. |
| `steps` | `StepRecommendation[]` | `{step_id, recommendation: RecommendResponse}` per step. |
| `total_est_cost_usd` | float | Sum of recommended-model costs across steps. |
| `total_est_cost_if_all_premium` | float | Sum if each step used its most expensive candidate — the savings baseline. |
| `confidence` | float `0–1` | Mean step confidence. |

See [`examples/04_workflow.py`](../examples/04_workflow.py).

---

## `POST /v1/feedback`

Report an outcome and close the learning loop. This both reinforces the memories that drove
the recommendation **and** records realized cost/token history that powers the observed and
rescaled cost-basis tiers.

### Request — `FeedbackRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `recommendation_id` | string | required | From a prior `/recommend` (or a step). |
| `chosen_model_id` | string | required | The model you **actually ran** (may differ from the recommendation; the right model's neighbors are credited). |
| `outcome` | enum | required | `success` \| `partial` \| `failure`. |
| `quality_score` | float `0–1` \| null | `null` | Caller-supplied; there is no LLM judge. Defaults applied per outcome if omitted (0.9 / 0.5 / 0.1). |
| `input_tokens` | int ≥ 0 \| null | `null` | Realized input tokens — **populate this** to enable the rescaled cost tier. |
| `output_tokens` | int ≥ 0 \| null | `null` | Realized output tokens (captures reasoning/thinking) — **populate this** for the rescaled tier. |
| `actual_cost_usd` | float ≥ 0 \| null | `null` | Realized $/call — enables the observed cost tier. |
| `latency_ms` | int ≥ 0 \| null | `null` | |
| `verified_in_production` | bool | `false` | Marks a real production outcome; gates lesson promotion. |
| `notes` | string \| null | `null` | |
| `idempotency_key` | string \| null | `null` | Dedupe key; derived from `recommendation_id + model` if omitted. |

### Response — `FeedbackResponse`

| Field | Type | Notes |
|-------|------|-------|
| `accepted` | bool | `false` with an `unknown_recommendation`/`memory_write_failed` warning on failure. |
| `record_id` | string \| null | The Mubit id of the upserted outcome record. |
| `reinforced_entry_ids` | string[] | The neighbor entry ids credited. |
| `updated_confidence` | float \| null | Mubit's updated `knowledge_confidence` for the primary entry. |
| `reflection_triggered` | bool | Whether reflection fired this call. |
| `lesson_promoted` | bool | Whether a durable lesson was promoted. |
| `warnings` | string[] | `unknown_recommendation`, `memory_write_failed`, `reinforcement_failed`, `lesson_promotion_failed`. |

### Example

```bash
curl -s http://localhost:8080/v1/feedback -H 'content-type: application/json' -d '{
  "recommendation_id": "…",
  "chosen_model_id": "claude-haiku-4-5",
  "outcome": "success",
  "quality_score": 0.95,
  "input_tokens": 180, "output_tokens": 640, "actual_cost_usd": 0.0034,
  "verified_in_production": true
}' | jq
```

---

## `GET /v1/models`

The current model catalog (cost + capability priors).

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `provider` | string | — | Filter by provider (case-insensitive). |
| `task_type` | enum | — | Keep only models with a capability prior for this task type. |
| `max_cost` | float | — | Keep only models whose max(input, output) $/Mtok ≤ this. |
| `include_stale` | bool | `true` | If false, prefer fresh-priced models (never returns empty solely due to staleness). |

### Response — `ModelsResponse`

`{ models: ModelCard[], catalog_version, refreshed_at, stale }`, sorted by input price.

**`ModelCard`**

| Field | Type | Notes |
|-------|------|-------|
| `model_id` | string | |
| `provider` | string | |
| `display_name` | string | |
| `input_cost_per_mtok` | float | USD per 1M input tokens. |
| `output_cost_per_mtok` | float | USD per 1M output tokens. |
| `cache_read_cost_per_mtok` | float \| null | Cached-input price. |
| `supports_prompt_caching` | bool | |
| `context_window` | int | |
| `max_output_tokens` | int \| null | |
| `capability_priors` | object | Benchmark-derived priors (e.g. `intelligence_index`). |
| `capability_by_task_type` | object | Per-task-type priors (e.g. `{"code": 0.82}`). |
| `cost_source` | string | Where prices came from. |
| `cost_fetched_at` | datetime \| null | |
| `cost_stale` | bool | |
| `capability_source` | string | |

---

## `GET /v1/strategies`

Surfaces the rules Mubit has promoted for a namespace — the "why" behind routing patterns.
(Requires a resolved tenant; in multi-tenant mode, send the Minima key.)

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `namespace` | string | — | Resolves to lane `minima:<namespace>`. |
| `lesson_types` | string[] | — | Filter by lesson type. |
| `max_strategies` | int `1–50` | `5` | |

### Response — `StrategiesResponse`

`{ namespace, lane, strategies: Strategy[], count }`, where each `Strategy` has
`strategy_id, description, supporting_lesson_count, avg_confidence, avg_reinforcement,
dominant_lesson_type, dominant_scope, lesson_ids[]`.

---

## `GET /v1/health`

Always returns `200`; reports degraded state in the body. Never requires auth (in
multi-tenant mode, an authenticated probe additionally reports its org's Mubit reachability).

```json
{
  "status": "ok",
  "mubit": {"reachable": true, "transport": "http", "latency_ms": 12,
            "endpoint": "http://127.0.0.1:3000", "org_id": "default"},
  "multitenant": false,
  "catalog": {"version": "…", "cost_source": "litellm+openrouter", "stale": false, "models": 42},
  "reasoner": {"provider": "none", "configured": false},
  "version": "0.1.0"
}
```

`status` is `degraded` when Mubit is unreachable. In that state `/recommend` still serves
prior-only recommendations.

---

## `POST|GET|DELETE /v1/admin/tenants`

Tenant provisioning. **Multi-tenant mode only** (returns `404` otherwise), guarded by the
`X-Minima-Provisioning-Key` header. Full details and schemas in
**[Multi-Tenancy](multi-tenancy.md)**.

- `POST /v1/admin/tenants` → mint a new org + Minima key (the key is shown **once**).
- `GET /v1/admin/tenants` → list orgs (summaries only; no secrets).
- `DELETE /v1/admin/tenants/{org_id}` → revoke an org.
