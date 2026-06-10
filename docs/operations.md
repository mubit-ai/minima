# Operations

How to run Costit in production: deployment, health, degradation, the catalog refresh loop,
durability, and what to watch.

## Running the service

Costit is an ASGI app (`costit.main:app`). For local/dev:

```bash
make run        # uvicorn with --reload
```

For production, run uvicorn without reload (or behind Gunicorn with uvicorn workers):

```bash
uv run uvicorn costit.main:app --host 0.0.0.0 --port 8080 --workers 4
```

> **Worker note:** the default recommendation store (`memory`) and propensity tracking are
> **per-process**, so a `recommendation_id` minted by one worker may not resolve in another,
> and feedback can miss. For multi-worker deployments set
> `COSTIT_RECOMMENDATION_STORE=sqlite` (shared backing file) so any worker can resolve any
> recommendation. The catalog refresh loop also runs per process — that's harmless
> (idempotent refresh), just slightly redundant.

## Health and readiness

`GET /v1/health` always returns `200` and reports degraded state in the body:

```json
{ "status": "ok|degraded",
  "mubit": {"reachable": true, "transport": "http", "latency_ms": 12},
  "multitenant": false,
  "catalog": {"version": "…", "cost_source": "…", "stale": false, "models": 42},
  "reasoner": {"provider": "none", "configured": false},
  "version": "0.1.0" }
```

- Use `status == "ok"` (or `mubit.reachable != false`) for a **readiness** probe.
- For a **liveness** probe, any `200` from `/v1/health` suffices — it doesn't require Mubit.
- In multi-tenant mode, an unauthenticated probe gets liveness only; pass a Costit key to
  also check that org's Mubit reachability.

## Degradation behavior

Costit keeps serving when its dependencies wobble:

| Condition | Behavior |
|-----------|----------|
| Mubit recall slow | Recall is bounded by `COSTIT_MEMORY_RECALL_TIMEOUT_MS`; on breach → prior-only + `recall_timeout`. |
| Mubit down | `/recommend` serves prior-only (`memory_unavailable`); `/health` reports `degraded`. |
| Stale prices | Last-good price snapshot used; `catalog_stale: true` + `prices_stale` warning. |
| Reasoner error | Deterministic result + `reasoner_failed`. |
| No reasoner configured | Escalation suggestions are surfaced as warnings but never block. |

The recommendation path makes exactly one hot Mubit call (recall). Writes
(`/feedback`) are not on the recommendation hot path, and reflection runs fire-and-forget.

## Catalog refresh

A background task refreshes model prices and capability data every
`COSTIT_CATALOG_REFRESH_SECONDS` (6h default):

- **Prices** from LiteLLM (primary) + OpenRouter (caching flags, context windows). On a
  fetch failure the last-good snapshot is kept and flagged stale after
  `COSTIT_CATALOG_STALE_AFTER_SECONDS` (24h).
- **Capability priors** ship as a checked-in static snapshot
  (`catalog/data/capability_priors.json`) loaded at startup with zero network dependency, so
  the service is fully functional offline.

`catalog_version` and `catalog_stale` appear on every `/recommend` response and in
`/v1/health`.

## Durability

| Concern | Setting |
|---------|---------|
| Recommendations survive restart (so feedback resolves) | `COSTIT_RECOMMENDATION_STORE=sqlite` |
| Recommendation resolution window | `COSTIT_RECOMMENDATION_TTL_SECONDS` (default 24h) |
| Tenant registry survives restart | `COSTIT_TENANT_STORE=sqlite` |
| Backing file location | `COSTIT_SQLITE_PATH`, `COSTIT_TENANT_STORE_PATH` |

Mount the sqlite paths on durable storage if you rely on them.

## What to monitor

- **Escalation rate** — fraction of recommendations with `reasoner_consulted`. High and not
  falling over time suggests thin memory; seed more or check that feedback is flowing.
- **`decision_basis` distribution** — the share of `memory` vs `prior` should rise as
  feedback accumulates. A stuck-high `prior` share means the loop isn't closing.
- **`cold_start` / `recall_timeout` / `memory_unavailable` warning rates** — recall health.
- **`latency_ms`** on `/recommend` — embedder-bound; spikes track Mubit/embedder latency.
- **Catalog staleness** — `catalog_stale: true` means the price feeds are failing.
- **Feedback acceptance** — `accepted: false` with `unknown_recommendation` often means the
  recommendation store is per-process (switch to sqlite) or the TTL is too short.

## Secret hygiene

- Never log or echo Mubit keys, Costit `cstk_…` keys, or provider API keys.
- Use a Mubit **data-plane** key (not an admin key) for `MUBIT_API_KEY`.
- In multi-tenant mode, store each org's Mubit key by reference (`env:NAME`), not inline.
- Keep `COSTIT_PROVISIONING_KEY` out of caller-facing config entirely.

## Tests in CI

```bash
make test    # unit + integration; no Mubit required
make lint    # ruff + mypy
make live    # end-to-end; requires a running Mubit (make run-mubit)
make eval    # offline RouterBench savings evaluation
```

Offline tests are hermetic with respect to a populated `.env` (the reasoner provider is
forced off for unit/integration), so a developer's local config can't leak into the suite.
