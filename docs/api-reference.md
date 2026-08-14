# API Reference

Base path: `/v1`. All request and response bodies are JSON. Interactive OpenAPI docs are
served at `/docs` when the service is running.

## Authentication

Auth is pass-through: the caller's Mubit API key is the credential. Present it as
`Authorization: Bearer mbt_…` and Minima uses it directly against the configured Mubit
endpoint, scoping all state to the org derived from that key. There is no provisioning
step and no Minima-issued keys. When no `Authorization` header is sent, the server falls
back to its env-configured `MUBIT_API_KEY` (single-tenant deployments). A bearer token
that is not a well-formed Mubit key (`mbt_…`) returns `401`, as does a missing key when
the server has none configured. See **[Multi-Tenancy](multi-tenancy.md)**.

`user_id` and `namespace` are within-org scoping fields, not auth boundaries. The tenant
boundary is the Mubit key → its Mubit instance.

## Errors

Errors are returned as `application/problem+json` (RFC 7807-style), with one exception
noted in the table below:

```json
{ "type": "about:blank", "title": "No candidate models", "status": 422,
  "detail": "no models match the supplied constraints" }
```

| Status | Title | When |
|--------|-------|------|
| `400` | Invalid request | A `ValueError` raised while handling the request. |
| `401` | Unauthorized | No Mubit key (none passed, none configured) or a malformed bearer token (not `mbt_…`). |
| `422` | No candidate models | Constraints eliminated every catalog model. |
| `422` | — | Request body fails schema validation. This one is **not** problem+json: it is FastAPI's own `application/json` body, `{"detail": [{"type": …, "loc": […], …}]}`. |

Note that `POST /v1/feedback` does not error on an unknown `recommendation_id`; it
returns `200` with `accepted: false` and an `unknown_recommendation` warning (so retried or
cross-org feedback fails safely).

---

## `POST /v1/recommend`

Recommend a model for a single task.

### Request: `RecommendRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `task` | `TaskInput` | required | The task to route (see below). |
| `cost_quality_tradeoff` | float `0–10` | `5.0` | 0 = cheapest acceptable, 10 = highest quality. Sets the quality threshold `τ`. |
| `constraints` | `Constraints` | `{}` | Hard limits on the candidate set (see below). |
| `user_id` | string \| null | `null` | Within-org actor label (not a tenant/auth boundary). Scopes recall. |
| `namespace` | string \| null | `null` | Within-org sub-scope (team/project/env). Maps to lane `minima:<namespace>`. |
| `incumbent_model_id` | string \| null | `null` | The model currently holding this session's prompt cache. Its estimate-basis input cost is priced partly at the cache-read rate, so stickiness emerges from honest cost accounting rather than a post-hoc override. |
| `max_candidates` | int `1–64` | `8` | Cap on candidates considered. |
| `allow_llm_escalation` | bool | `true` | Emit diagnostic `escalation_suggested:*` warnings when evidence is thin/tied/conflicted; `false` suppresses them. |
| `explain` | bool | `true` | Include `evidence[]` refs on each ranked model. |
| `baseline_model_id` | string \| null | `null` | The model you would have used without Minima; powers the `vs declared` baseline in `GET /v1/savings`. |

**`TaskInput`**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `task` | string | required | Raw task/prompt text; embedded by Mubit for recall. |
| `task_type` | enum \| null | `null` | One of `code, summarization, extraction, qa, reasoning, classification, translation, creative, rag, tool_use, other`. Heuristic-classified if omitted. |
| `difficulty` | enum \| null | `null` | One of `trivial, easy, medium, hard, expert`. Heuristic-classified if omitted. |
| `task_type_confidence` | float `0–1` \| null | `null` | Your classifier's confidence in the `task_type`/`difficulty` you supplied. Diagnostic only — the override wins regardless. |
| `expected_input_tokens` | int ≥ 0 \| null | `null` | Feeds the cost estimate; defaults to `MINIMA_DEFAULT_INPUT_TOKENS`. |
| `expected_output_tokens` | int ≥ 0 \| null | `null` | Feeds the cost estimate; defaults to `MINIMA_DEFAULT_OUTPUT_TOKENS`. |
| `tags` | string[] | `[]` | Propagated to Mubit `env_tags` (e.g. `lang:python`) for version-aware recall. |

**`Constraints`** (all optional; unset fields impose no limit)

| Field | Type | Notes |
|-------|------|-------|
| `allowed_providers` | string[] \| null | Whitelist by provider. |
| `candidate_models` | string[] \| null | Restrict to these model ids. |
| `excluded_models` | string[] \| null | Blacklist by model id. |
| `max_cost_per_call` | float ≥ 0 \| null | USD hard filter on estimated cost. If it eliminates every candidate the request fails with `422 No candidate models`. |
| `min_quality` | float `0–1` \| null | Predicted-success floor; raises `τ`. |
| `require_prompt_caching` | bool | Keep only models that support prompt caching. |
| `max_latency_ms` | int > 0 \| null | Drops candidates whose **observed** latency exceeds this budget (a model without latency evidence is never dropped). Warns `no_model_within_latency_budget` and relaxes if it eliminates all. |
| `require_context_window` | int > 0 \| null | Keep only models with at least this context window. |

### Response: `RecommendResponse`

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
| `classification_profile` | object \| null | Structured trace of the classifier path: rule checks, feature vector, source, and timings. |
| `warnings` | string[] | See **Warnings** below. |
| `selection_policy` | enum | `thompson` (the default posterior-sampling policy) \| `argmin` (deterministic — per-org opt-out, or a single-candidate/capped decision). |
| `recommended_actions` | string[] | Near-free cost-saving actions to apply (e.g. `enable_prompt_cache`). |
| `stage_latency_ms` | object | Per-stage latency breakdown in milliseconds (`{stage: ms}`). |
| `cluster_key_version` | string | Version of the cluster-key space this decision was keyed under (`"v1"`). |

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
| `est_latency_ms` | float \| null | Observed latency percentile from similar past outcomes; `null` without evidence. |
| `latency_basis` | string | How `est_latency_ms` was derived (e.g. `observed_p75`); empty without evidence. |
| `est_cost_low` | float \| null | Low end of the data-grounded predictable cost band ($). |
| `est_cost_high` | float \| null | High end of the same band. |
| `cost_band_basis` | string | How the band was derived (e.g. `observed_p25_p75`, `rescaled_p25_p75`); empty without a band. |
| `success_interval_width` | float `0–1` | Width of the 95% credible interval on `predicted_success` — how thin the evidence is. |

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
| `memory_unavailable` | Recall errored; prior-only. Replaced by the class-specific label when one is known (`memory_unreachable`, `memory_auth_failed`, `memory_rejected_payload`, `memory_unsupported`, `memory_server_error`, `memory_recall_bug`). |
| `keyed_lookup_degraded` | The deterministic per-`(cluster, model)` evidence channel is down; the decision rests on ANN recall alone. |
| `memory_drift:repeated` · `memory_drift:stagnant` | Mubit's drift monitor flagged this lane as looping / on a failure streak. Diagnostic; never a routing input. |
| `neighbor_classified` | The heuristic classifier was unsure; recalled neighbors decided the task type/difficulty. |
| `recall_invalidated_skipped:<n>` | `<n>` recalled records were tombstoned and excluded from ranking. |
| `prices_stale` | Catalog prices older than the staleness window. |
| `no_model_within_latency_budget` | `max_latency_ms` eliminated every candidate; the latency constraint is relaxed for ranking. |
| `cold_start_margin_applied` | Prior-only candidates had to clear `τ` plus the cold-start margin to stay eligible. |
| `no_model_meets_threshold` | No candidate cleared `τ`; recommended the highest-success one. |
| `thompson_pick` | Posterior sampling picked a candidate other than the deterministic cheapest-clearing-`τ` one (which becomes the fallback). |
| `explore_budget_capped` | A Thompson deviation was refused because the running exploration share hit `MINIMA_EXPLORE_SHARE_CAP`; the argmin pick stands. |
| `escalation_suggested:<reason>` | Escalation criteria met (`thin_evidence`, `low_confidence`, `low_recall_confidence`, `tie`, `conflict`). Diagnostic only — your harness owns the cascade. |
| `escalation_rate_high:<cluster>` | This cluster's realized recovery-deferral rate is above the warn threshold. |

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

### Request: `WorkflowRequest`

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

### Response: `WorkflowResponse`

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
the recommendation and records realized cost/token history that powers the observed and
rescaled cost-basis tiers.

### Request: `FeedbackRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `recommendation_id` | string | required | From a prior `/recommend` (or a step). |
| `chosen_model_id` | string | required | The model you **actually ran** (may differ from the recommendation; the right model's neighbors are credited). |
| `outcome` | enum | required | `success` \| `partial` \| `failure`. |
| `quality_score` | float `0–1` \| null | `null` | Caller-supplied judge/eval score. Omitted stays `null` (no fabricated default). A score contradicting the outcome label is clamped with a `quality_outcome_mismatch` warning. |
| `evidence_source` | enum \| null | `null` | Label provenance: `gate` (deterministic check — the only origin that may claim verified-in-production) \| `judge` \| `human` \| `none` (telemetry only; never teaches the success posterior). |
| `error_cause` | enum \| null | `null` | For failures: `infra` (429/5xx/timeout — never learned as model quality) \| `quality`. |
| `input_tokens` | int ≥ 0 \| null | `null` | Realized input tokens — **populate this** to enable the rescaled cost tier. |
| `output_tokens` | int ≥ 0 \| null | `null` | Realized output tokens (captures reasoning/thinking) — **populate this** for the rescaled tier. |
| `actual_cost_usd` | float ≥ 0 \| null | `null` | Realized $/call — enables the observed cost tier. |
| `latency_ms` | int ≥ 0 \| null | `null` | |
| `iterations` | int ≥ 0 \| null | `null` | Agent-loop turns to resolution. |
| `chosen_effort` | string \| null | `null` | Reasoning-effort level actually used, if varied. |
| `parent_rec_id` | string \| null | `null` | `recommendation_id` of the preceding rung in a recovery-ladder chain; lets the server assemble same-task preference pairs. |
| `escalation_reason` | enum \| null | `null` | Why the parent rung failed (sent alongside `parent_rec_id`): `gate_failed` \| `judge_failed` \| `transient` \| `hard_error`. |
| `provider_model_snapshot` | string \| null | `null` | Exact model id the provider reported serving (e.g. a dated snapshot) — the key for version-churn posterior resets. |
| `label_propensity` | float `0<x≤1` \| null | `null` | Probability this turn was selected for labeling (`1.0` for gate labels). Keeps OPE/calibration unbiased under sampled judging. |
| `signals` | object \| null | `null` | Implicit-signal map, `{key: bool}`, max 16 keys matching `^[a-z_]{1,32}$` (a violation is a validation error). Absent key = not observed, never `false`. Consumed only by the opt-in weak-supervision label model. |
| `step_outcomes` | `StepOutcome[]` | `[]` | Per-step verdicts for multi-step work (cap 32/call): `{step_id, step_name?, outcome, signal? [-1,1], rationale?, directive_hint?}`. |
| `verified_in_production` | bool | `false` | DEPRECATED — send `evidence_source="gate"` instead. |
| `judged` | bool \| null | `null` | DEPRECATED — send `evidence_source` instead. |
| `notes` | string \| null | `null` | |
| `idempotency_key` | string \| null | `null` | Dedupe key; derived from `recommendation_id + model` if omitted. |

### Response: `FeedbackResponse`

| Field | Type | Notes |
|-------|------|-------|
| `accepted` | bool | `false` with an `unknown_recommendation` warning, or with the class-specific memory-write warning (`memory_auth_failed`, `memory_unreachable`, …) when the outcome write fails. |
| `record_id` | string \| null | The Mubit id of the upserted outcome record. |
| `reinforced_entry_ids` | string[] | The neighbor entry ids credited. |
| `updated_confidence` | float \| null | Mubit's updated `knowledge_confidence` for the primary entry. |
| `reflection_triggered` | bool | Whether reflection fired this call. |
| `lesson_promoted` | bool | Whether a durable lesson was promoted. |
| `step_outcomes_recorded` | int | How many `step_outcomes` were relayed to memory. |
| `warnings` | string[] | `unknown_recommendation`, `unlabeled_telemetry_only`, `infra_failure_telemetry_only`, `decision_corrected`, `duplicate_feedback_ignored`, `reinforcement_failed`, `lesson_promotion_failed`, `quality_outcome_mismatch`, `late_feedback_no_attribution`, `step_outcomes_capped:<n>`, `step_outcomes_partial`, and the class-specific memory-write labels `memory_auth_failed`, `memory_rejected_payload`, `memory_unsupported`, `memory_server_error`, `memory_unreachable`, `memory_write_bug`. |

### Example

```bash
curl -s http://localhost:8080/v1/feedback -H 'content-type: application/json' -d '{
  "recommendation_id": "…",
  "chosen_model_id": "claude-haiku-4-5",
  "outcome": "success",
  "quality_score": 0.95,
  "evidence_source": "gate",
  "input_tokens": 180, "output_tokens": 640, "actual_cost_usd": 0.0034
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

### Response: `ModelsResponse`

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

Surfaces the rules Mubit has promoted for a namespace: the "why" behind routing patterns.
(Requires a resolved tenant, so pass your Mubit key or rely on the server's configured one.)

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `namespace` | string | — | Resolves to lane `minima:<namespace>`. |
| `lesson_types` | string[] | — | Filter by lesson type. |
| `max_strategies` | int `1–50` | `5` | |

### Response: `StrategiesResponse`

`{ namespace, lane, strategies: Strategy[], count, warnings[] }`, where each `Strategy` has
`strategy_id, description, supporting_lesson_count, avg_confidence, avg_reinforcement,
dominant_lesson_type, dominant_scope, lesson_ids[]`. A Mubit outage degrades to `200` with
an empty `strategies` list and a `memory_unavailable` warning, so check `warnings[]` before
reading an empty list as "no strategies".

---

## `GET /v1/savings` · `GET /v1/calibration` · `GET /v1/policy-value`

The measurement layer over your account's decision ledger:

- **`/v1/savings`** (`namespace?`, `days=30`, `group_by=cluster|task_type|lane`) — estimated **and** realized savings against two explicit baselines: `vs premium` (most expensive scored candidate; generous) and `vs declared` (your `baseline_model_id`; honest). `health.feedback_coverage` tells you how much weight the realized figures can bear.
- **`/v1/calibration`** (`namespace?`, `days=30`) — per-task-type expected calibration error (`ece`, `ece_shrunk`) of `predicted_success` vs realized outcomes, plus sustained drift flags per `(cluster, model)`.
- **`/v1/policy-value`** (`namespace?`, `days=30`) — doubly-robust off-policy estimates (`RegretReport`): per-policy value, `regret_vs_oracle`, with `stochastic_share` and `n_trusted` surfaced so the number can't overclaim.

---

## `GET /v1/capabilities`

Feature handshake (no auth): `{ plan, workflow, api_version, honored_constraints[] }`. Read once at startup and gate optional features on what the server actually supports.

---

## `POST /v1/diagnose`

Failure lessons matching an error: "here's how this failed before". The harness recovery
ladder calls this at a verified failure so the retry is briefed by memory. Degrades like
the recommend hot path (a Mubit outage returns an empty list + `memory_unavailable`, never
a 500).

### Request: `DiagnoseRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `error_text` | string (required) | — | The error/failure output to match. |
| `error_type` | string | — | Optional classifier hint. |
| `limit` | int `1–25` | `5` | |
| `namespace` | string | — | Resolves to lane `minima:<namespace>`. |
| `user_id` | string | — | |

### Response: `DiagnoseResponse`

`{ namespace, lane, failure_lessons: FailureLesson[], summary, total_failure_lessons,
warnings[] }`, where each `FailureLesson` has `lesson_id, content, lesson_type,
importance, confidence`.

---

## `GET /v1/memory/health`

Per-namespace memory hygiene: entry counts, stale entries, contradictions, low-confidence
counts, promotion candidates. Same graceful degradation as `/v1/diagnose`.

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `namespace` | string | — | Resolves to lane `minima:<namespace>`. |
| `stale_threshold_days` | int `1–365` | `30` | |

### Response: `MemoryHealthResponse`

`{ namespace, lane, entry_counts: {type: count}, stale_entries, contradictions,
low_confidence_count, promotion_candidates, section_health,
posterior_resets: PosteriorReset[], warnings[] }`, where each `PosteriorReset`
(an active reset epoch; evidence older than it is zero-weighted at ranking time) has
`{model, lane, cluster, at, cause}`.

---

## `GET /v1/health`

Always returns `200`; reports degraded state in the body. Never requires auth (an
unauthenticated probe gets liveness only; a key-bearing probe additionally reports that
org's Mubit reachability).

```json
{
  "status": "ok",
  "mubit": {"reachable": true, "transport": "http", "status_code": 200,
            "endpoint": "http://127.0.0.1:3000", "org_id": "default"},
  "auth": "passthrough",
  "classifier": {"id": "regex-v1", "embed_loaded": false, "required": false},
  "catalog": {"version": "…", "cost_source": "litellm+openrouter", "stale": false, "models": 42},
  "version": "0.1.0"
}
```

`status` is `degraded` when Mubit is unreachable. In that state `/recommend` still serves
prior-only recommendations.
