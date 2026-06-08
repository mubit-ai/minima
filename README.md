# Costit

Costit recommends a cheaper or alternate LLM model for a given task, so LLM-driven
workflows spend fewer tokens without losing the quality the task actually needs.

Costit **only recommends** — it never proxies a call, runs a model, rewrites a prompt,
or caches. It is a stack-agnostic advice layer: ask it which model to use, run that model
yourself, then tell Costit how it went.

## How it works

1. **Recommend.** `POST /v1/recommend` with a task. Costit recalls similar past
   `task → model → outcome` records from [Mubit](https://docs.mubit.ai) memory, aggregates
   each candidate model's empirical success rate, combines it with cost and capability
   priors, and returns the cheapest model expected to clear a quality bar — plus a ranked
   list and a fallback model. A `cost_quality_tradeoff` slider (0 = cheapest acceptable,
   10 = highest quality) moves the bar.
2. **Run it yourself.** Costit hands back a `recommendation_id`; you run the recommended
   model in your own stack.
3. **Feed back.** `POST /v1/feedback` with the `recommendation_id`, the outcome, and a
   quality score. Costit writes the outcome to Mubit and reinforces the memories that
   informed the recommendation, so the next recommendation for a similar task is sharper.

When memory evidence is thin or conflicting, Costit escalates the decision to a cheap LLM
reasoner (configurable; off by default).

## Endpoints

- `POST /v1/recommend` — recommend a model for one task
- `POST /v1/recommend/workflow` — recommend a model per step of a multi-step workflow
- `POST /v1/feedback` — report an outcome and close the learning loop
- `GET  /v1/models` — the current model catalog (cost + capability priors)
- `GET  /v1/health` — service, Mubit, catalog, and reasoner status

## Quickstart

```bash
uv sync --extra dev
cp .env.example .env            # set MUBIT_API_KEY (and MUBIT_ENDPOINT if not local)

# (optional) seed cold-start memory from an offline benchmark
uv run costit-seed --limit 2000 --lane costit:default

uv run uvicorn costit.main:app --host 0.0.0.0 --port 8080
```

Costit talks to a Mubit runtime at `MUBIT_ENDPOINT` (defaults to a local runtime at
`http://127.0.0.1:3000`; start one with `make run-mubit` in the Mubit repo). It uses
Mubit's server-side embeddings, so Costit needs no embedding model of its own.

## Configuration

All configuration is via environment variables (see `.env.example`). The only required
value is `MUBIT_API_KEY`.

## Development

```bash
make install     # uv sync --extra dev
make test        # unit + integration (no Mubit needed)
make lint        # ruff + mypy
make live        # end-to-end against a running Mubit (pytest -m live)
```
