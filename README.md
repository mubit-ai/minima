# Costit

**Recommend a cheaper LLM model for each task, so LLM-driven workflows spend fewer tokens
without losing the quality the task actually needs.**

Costit **only recommends** — it never proxies a call, runs a model, rewrites a prompt, or
caches. It is a stack-agnostic advice layer backed by [Mubit](https://docs.mubit.ai) memory:
ask which model to use, run that model yourself, then tell Costit how it went. Because it
sits *beside* your call rather than in front of it, **it adds zero latency to your real LLM
request.**

```
  POST /v1/recommend  ──▶  you run the model  ──▶  POST /v1/feedback
   (recall + rank)          (your stack)            (write outcome, reinforce memory)
        ▲                                                           │
        └──────────────  recommendations get sharper  ─────────────┘
```

## Why it works

The recommendation engine is non-parametric **k-NN over history**: recall similar past
`task → model → outcome` records, aggregate each candidate model's empirical success rate,
and pick the cheapest model expected to clear a quality bar. Mubit is that substrate off the
shelf — semantic recall, per-entry reinforcement, lesson promotion, and strategy surfacing.
Every `POST /v1/feedback` makes the next recommendation sharper and the cost ranking more
accurate.

A `cost_quality_tradeoff` slider (0 = cheapest acceptable, 10 = highest quality) moves the
bar. When memory is thin or conflicting, Costit can escalate to a cheap-LLM reasoner
(configurable, off by default).

### Cost ranking that reflects reality

A flat token estimate assumes a fixed completion length, so it ignores reasoning/thinking
tokens and mis-ranks a model with cheap list prices but heavy internal reasoning. Costit
ranks candidates by what they **really** cost, choosing one basis for the whole candidate
set:

- **rescaled** (best) — this request's input priced + the model's *observed* output-token
  behavior; size-exact **and** reasoning-aware.
- **observed** — robust median of realized `$/call` from recalled outcomes.
- **estimate** (cold start) — token estimate from catalog prices.

The basis climbs `estimate → observed → rescaled` as your `/feedback` calls accumulate
realized tokens and cost. See [Concepts → Cost-basis tiers](docs/concepts.md#cost-basis-tiers-estimate--observed--rescaled).

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/recommend` | Recommend a model for one task. |
| `POST /v1/recommend/workflow` | Recommend a model per step of a multi-step workflow. |
| `POST /v1/feedback` | Report an outcome and close the learning loop. |
| `GET  /v1/models` | The current model catalog (cost + capability priors). |
| `GET  /v1/strategies` | Rules Mubit has promoted for a namespace (explainability). |
| `GET  /v1/health` | Service, Mubit, catalog, and reasoner status. |
| `POST\|GET\|DELETE /v1/admin/tenants` | Tenant provisioning (multi-tenant mode only). |

Full schemas, fields, warnings, and error formats: **[API Reference](docs/api-reference.md)**.

## Quickstart

```bash
uv sync --extra dev
cp .env.example .env                       # set MUBIT_API_KEY (+ MUBIT_ENDPOINT if not local)

# optional: seed cold-start memory so day-one picks are grounded
uv run costit-seed --dataset synthetic --limit 2000 --lane costit:default

make run                                   # uvicorn on :8080 (interactive docs at /docs)
```

```bash
# recommend
curl -s localhost:8080/v1/recommend -H 'content-type: application/json' -d '{
  "task": {"task": "Summarize this incident report into 3 bullets.",
           "task_type": "summarization"},
  "cost_quality_tradeoff": 3
}' | jq

# ...run the recommended model yourself, then close the loop
curl -s localhost:8080/v1/feedback -H 'content-type: application/json' -d '{
  "recommendation_id": "<from above>", "chosen_model_id": "claude-haiku-4-5",
  "outcome": "success", "quality_score": 0.95,
  "input_tokens": 1760, "output_tokens": 110, "actual_cost_usd": 0.0021,
  "verified_in_production": true
}' | jq
```

Costit talks to a Mubit runtime at `MUBIT_ENDPOINT` (defaults to `http://127.0.0.1:3000`;
start one with `make run-mubit` in the Mubit repo) and uses Mubit's server-side embeddings,
so it needs no embedding model of its own.

## Python client

```python
from costit_client import CostitClient

with CostitClient("http://localhost:8080") as costit:
    rec = costit.recommend("Write a Python CSV parser.", cost_quality_tradeoff=3)
    # ... run rec.recommended_model.model_id yourself ...
    costit.feedback(rec.recommendation_id, rec.recommended_model.model_id, "success",
                    quality_score=0.95, input_tokens=180, output_tokens=640,
                    actual_cost_usd=0.0034, verified_in_production=True)
```

Sync + async clients and zero-code `autocapture`: **[Python Client SDK](docs/client-sdk.md)**.

## Documentation

| Doc | What's in it |
|-----|--------------|
| [Getting Started](docs/getting-started.md) | Install, configure, run, first recommendation. |
| [Concepts](docs/concepts.md) | The loop, the algorithm, cost-basis tiers, escalation, how it improves. |
| [API Reference](docs/api-reference.md) | Every endpoint, full schemas, warnings, errors. |
| [Configuration](docs/configuration.md) | Every environment variable + tuning guidance. |
| [Python Client SDK](docs/client-sdk.md) | `costit_client` clients + autocapture. |
| [Cold-Start Seeding](docs/seeding.md) | Load history so day-one picks are grounded. |
| [Multi-Tenancy](docs/multi-tenancy.md) | One deployment, many orgs, per-org Mubit instances. |
| [Operations](docs/operations.md) | Deployment, health, degradation, monitoring, secrets. |
| [Examples](docs/examples.md) | Guided tour of the runnable examples. |

## Examples

Runnable, progressively advanced — in **[`examples/`](examples/)**:

| # | Example | Shows |
|---|---------|-------|
| 1 | [`01_quickstart.sh`](examples/01_quickstart.sh) | Raw `curl` against every endpoint. |
| 2 | [`02_recommend_and_feedback.py`](examples/02_recommend_and_feedback.py) | The core loop with the SDK. |
| 3 | [`03_constraints_and_tradeoff.py`](examples/03_constraints_and_tradeoff.py) | Constraints + slider sweep. |
| 4 | [`04_workflow.py`](examples/04_workflow.py) | Per-step workflow recommendations. |
| 5 | [`05_autocapture.py`](examples/05_autocapture.py) | Zero-code intake via `mubit.learn`. |
| 6 | [`06_routed_llm_call.py`](examples/06_routed_llm_call.py) | Routing a real Claude call + feedback. |
| 7 | [`07_multitenant_admin.py`](examples/07_multitenant_admin.py) | Provision an org, call as that tenant. |

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example) and
[Configuration](docs/configuration.md)). The only required value is `MUBIT_API_KEY` (in
single-tenant mode). Notable knobs:

- `COSTIT_USE_OBSERVED_COST` / `COSTIT_OBSERVED_COST_MIN_N` — rank by realized cost.
- `COSTIT_REASONER_PROVIDER` — enable the cheap-LLM escalation tier (`anthropic` / `gemini`).
- `COSTIT_RECOMMENDATION_STORE=sqlite` — durable recommendation resolution (multi-worker).
- `COSTIT_MULTITENANT` — serve many orgs from one deployment.

## Development

```bash
make install     # uv sync --extra dev
make test        # unit + integration (no Mubit needed)
make lint        # ruff + mypy
make live        # end-to-end against a running Mubit (pytest -m live)
make eval        # offline RouterBench savings evaluation (pytest -m eval)
make fmt         # ruff --fix + format
make seed        # costit-seed (LIMIT=, LANE= overridable)
```

## Project layout

```
src/costit/
  api/routers/      recommend · feedback · models · strategies · health · admin
  recommender/      engine · classify · aggregate · score · escalation · propensity · recstore
  memory/           adapter (only Mubit touchpoint) · records · keys · threadpool
  catalog/          store · merge · refresh · sources/{litellm,openrouter} · data/*.json
  llm/              base · anthropic · gemini · registry   (the escalation reasoner)
  tenancy/          runtime · registry · context · keys · secrets
  seeding/          routerbench · synthetic · run_seed (costit-seed CLI)
  schemas/          common · recommend · workflow · feedback · models_catalog · strategies · admin
client_sdk/costit_client/   client (sync+async) · autocapture · errors
docs/               full documentation       examples/   runnable examples
tests/              unit · integration (FakeMemory) · live (-m live) · eval (-m eval)
```
