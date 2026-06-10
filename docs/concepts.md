# Concepts

## The problem Costit solves

LLM workflows overspend by sending every call to a top-tier model when a cheaper model
would do a portion of the work just as well. Token cost is the lever; **model choice is the
cheapest knob to turn**. Costit turns that knob, per task, based on what models have
actually done on similar tasks before.

## Recommend-only, zero added latency

Costit **only recommends**. It does not proxy your call, execute a model, rewrite prompts,
cache, or compress. You ask "which model should run this?", it answers, and you run the
model yourself in your own stack. Because Costit sits *beside* your call rather than in
front of it, it adds **zero latency to the actual LLM request**. The only Costit round-trip
is the recommendation lookup, which is recall-bound (~100–300ms on a GPU embedder).

## The loop

```
        ┌─────────────────────────────────────────────────────────┐
        │                                                           │
        ▼                                                           │
  POST /v1/recommend  ──▶  you run the model  ──▶  POST /v1/feedback
   (recall + rank)          (your stack)            (write outcome,
                                                     reinforce memory)
        ▲                                                           │
        │              memory gets sharper for next time           │
        └───────────────────────────────────────────────────────-─┘
```

1. **Recommend.** Costit recalls similar past `task → model → outcome` records from Mubit,
   aggregates each candidate model's empirical success rate, combines it with cost and
   capability priors, and returns the cheapest model expected to clear a quality bar.
2. **Run it yourself.** Costit hands back a `recommendation_id`; you run the recommended
   model.
3. **Feed back.** You report the outcome and a quality score. Costit writes the outcome to
   Mubit, reinforces the exact memories that drove the decision, and (on strong
   verified-in-production results) promotes a durable lesson.

## Why Mubit

The recommendation engine is **non-parametric k-NN over history**: recall similar past
records, aggregate per-model success, pick the cheapest model clearing a threshold. Mubit is
that substrate off the shelf — semantic recall (HNSW over server-side embeddings),
per-entry reinforcement (`success_count` / `failure_count` + Bayesian
`knowledge_confidence`), lesson promotion via `reflect()`, and strategy surfacing via
`surface_strategies()` for explainability. Costit touches the Mubit SDK in exactly one place
(`memory/adapter.py`); everything else is provider-agnostic.

## The recommendation algorithm

Implemented in `recommender/engine.py`. For each request:

1. **Classify** (`classify.py`). Use the caller's `task_type` / `difficulty` hints if given;
   otherwise a fast heuristic infers them. If the heuristic is uncertain (`other`) and
   escalation is allowed, the cheap-LLM reasoner can refine the classification. From this,
   compute a `task_cluster` (e.g. `code:hard`) and a stable `task_fingerprint`.
2. **Select candidates** (`_select_candidates`). Start from the full catalog, apply
   constraint filters (`candidate_models`, `allowed_providers`, `excluded_models`,
   `require_prompt_caching`, `require_context_window`), pre-rank by capability prior, and cap
   to `max_candidates`.
3. **Recall** (`memory/adapter.recall`). Retrieve up to `COSTIT_MEMORY_RECALL_LIMIT` similar
   outcome records from the request's lane, with a hard recall timeout. On timeout or empty
   recall, fall back to the prior-only path.
4. **Aggregate per model** (`aggregate.py`). Weight each recalled neighbor by
   `similarity × knowledge_confidence × staleness_decay`, then compute a Beta-smoothed
   empirical success rate per candidate (so models with no neighbors fall back to their
   capability prior, not to 0.5). An optional **inverse-propensity weighting** step corrects
   for the selection bias that you've historically sent certain task types to certain models.
5. **Score** (`score.py`). Combine the predicted success with the estimated cost (see
   **Cost-basis tiers** below). The slider sets a quality threshold `τ`.
6. **Optimize** (`_optimize`). Among models predicted to clear `τ`, recommend the
   **cheapest** (tie-break: higher success, then higher confidence). If none clear `τ`,
   recommend the highest-predicted-success model and warn `no_model_meets_threshold`. A
   `fallback_model` is chosen as a more reliable retry target.
7. **Escalate** (`escalation.py`) when evidence is thin or conflicting — see below.

## The cost/quality slider

`cost_quality_tradeoff` (0–10, default 5) maps to a quality threshold:

```
τ = τ_min + (cost_quality_tradeoff / 10) × (τ_max − τ_min)
```

with `τ_min = 0.55` and `τ_max = 0.92` by default. **0 means "cheapest model that's
acceptable"; 10 means "highest quality regardless of cost".** A request's `min_quality`
constraint raises the floor. The slider also shifts the ranking weight between predicted
success and normalized cost.

## Cost-basis tiers (estimate → observed → rescaled)

The single most important accuracy mechanism. A flat token estimate assumes a fixed output
length, so it **ignores reasoning/thinking tokens** — which mis-ranks a model with cheap
list prices but heavy internal reasoning (e.g. a "flash" model that spends many output
tokens thinking before it answers). Costit ranks candidates by what they *really* cost.

One basis is chosen for the **whole candidate set** so all costs are compared like-for-like
(`choose_cost_basis`), preferring the most grounded tier every candidate supports:

| Tier | Used when | How cost is computed | Breakdown key |
|------|-----------|----------------------|---------------|
| **rescaled** | every candidate has ≥ `MIN_N` observations carrying `output_tokens` | `this_request_input_tokens × input_price + observed_median_output_tokens × output_price` — size-exact for this request **and** reasoning-aware | `rescaled`, `obs_output_tokens` |
| **observed** | every candidate has ≥ `MIN_N` realized `cost_usd` observations (and prompt caching is not required) | robust similarity-weighted **median** of realized `cost_usd` per call | `observed_avg` |
| **estimate** | cold start, or `COSTIT_USE_OBSERVED_COST=false` | `input_tokens × input_price + output_tokens × output_price`, using the request's expected tokens or per-task-type defaults; cache-read price when applicable | `input`, `output` |

`MIN_N` is `COSTIT_OBSERVED_COST_MIN_N` (default 3). The chosen basis is reflected in each
`RankedModel.est_cost_breakdown`, and the rationale tags the number `obs` (grounded) or
`est` (cold). The realized `cost_usd` / `input_tokens` / `output_tokens` come from your
`POST /v1/feedback` calls — so the more you feed back, the more the ranking climbs from
estimate → observed → rescaled.

> The **median** (not mean) makes the observed/rescaled tiers robust to outlier calls. The
> weight is similarity-only (not staleness-decayed) because cost is an objective fact about a
> model, not a quality signal that should fade.

## Escalation to a cheap-LLM reasoner

When deterministic evidence is thin or conflicting, Costit can consult a cheap LLM
(Anthropic Haiku or Gemini Flash, configurable; **off by default**). It fires only when
`allow_llm_escalation` is true **and** any of:

- **thin evidence** — total recalled weight below `COSTIT_ESCALATION_W_MIN`, or fewer than
  `COSTIT_ESCALATION_N_MIN` candidate models have any neighbor;
- **low confidence** — the recommended model's neighborhood confidence below
  `COSTIT_ESCALATION_C_MIN`;
- **conflict/tie** — the top two candidates' scores are within `COSTIT_ESCALATION_TIE_DELTA`.

On trigger, Costit builds a memory context block (`get_context`), asks the reasoner to rank
the candidates with structured output, and **blends** the reasoner's predicted success with
the deterministic one (`COSTIT_REASONER_BLEND`, default 0.5). On any reasoner error or
parse failure it falls back to the deterministic result and warns `reasoner_failed`. The
reasoner is the explicit slow tier and never touches your real LLM call.

`decision_basis` on the response tells you which path won: `memory`, `prior`, or `llm`.

## How it gets better over time

| Phase | What's happening | Typical `decision_basis` |
|-------|------------------|--------------------------|
| **Cold start (day 0)** | no history; leans on capability priors and flat estimates; reasoner fires often | `prior` (with `cold_start`) |
| **Warming up** | `/feedback` outcomes cross `MIN_N`; cost basis climbs estimate → observed → rescaled; reasoner fires less | mix of `memory` and `prior` |
| **Mature** | dense history; most picks are empirical; reflection has promoted durable lessons; IPW has de-biased your routing history | mostly `memory` |

Seed RouterBench (or synthetic) history to skip most of the cold-start phase on day one.

## The learning loop in detail (`POST /v1/feedback`)

1. Resolve the `recommendation_id` locally → the recalled neighbors, cluster, lane, and
   user. (Org-scoped: an id minted for another org resolves to nothing, so orgs can't credit
   or poison each other.)
2. Upsert one durable **outcome record** keyed `costit:om:<cluster>:<model>`, carrying
   `cost_usd`, `input_tokens`, `output_tokens`, and `quality_score`.
3. Credit the exact recalled neighbors that drove the pick (`record_outcome`), bumping their
   reinforcement counters and `knowledge_confidence`.
4. On a verified-in-production strong success (quality ≥ `COSTIT_LESSON_MIN_QUALITY`),
   promote a durable **Lesson** that feeds `reflect()` rule promotion.
5. Trigger reflection every `COSTIT_REFLECT_EVERY_N` feedbacks (default 25), or on any
   verified-prod failure.

## Degradation behavior

Costit is designed to keep serving when Mubit is slow or down:

- **Recall timeout / Mubit unavailable** → prior-only recommendation with a `recall_timeout`
  or `memory_unavailable` warning.
- **Stale prices** → still serves, with `catalog_stale: true` and a `prices_stale` warning;
  the last-good price snapshot is used.
- **No models match constraints** → `422` (`NoCandidatesError`).
- **Reasoner unconfigured but escalation suggested** → deterministic result with a
  `reasoner_disabled` warning.
