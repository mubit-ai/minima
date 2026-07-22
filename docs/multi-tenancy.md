# Multi-Tenancy

One Minima deployment serves many organizations. There is no tenant registry, no
provisioning step, and no Minima-issued keys: auth is **pass-through**, and the client's
Mubit API key IS the credential. Each org brings its own Mubit key (its own Mubit
project/instance), and that key both authenticates the call and selects the tenant.

## The model

- **Tenant boundary = the Mubit key.** Callers pass their key as
  `Authorization: Bearer mbt_…`. Minima uses it directly against the configured
  `MUBIT_ENDPOINT` — each org's memory lives in the Mubit instance its own key unlocks.
- **`org_id` is derived from the key.** A canonical `mbt_<instance>_…` key yields the
  instance segment; anything else falls back to a hash of the key. One `TenantContext`
  (memory adapter + recommender + org-scoped stores) is lazily built and cached per key.
- **State is org-scoped.** The recommendation store, decision log, and durable refs are
  partitioned by `org_id`, so a `recommendation_id` minted for one org resolves to nothing
  for another — orgs cannot credit or poison each other's learning.
- **`namespace` and `user_id` are intra-org** sub-scoping (team/project/env), not tenant
  boundaries. A namespace maps to lane `minima:<namespace>` inside the org's own Mubit.

## Single-tenant mode is the same path

When a request carries no `Authorization` header, Minima falls back to the env-configured
`MUBIT_API_KEY` — that is all "single-tenant mode" is. Setting only `MUBIT_API_KEY` gives
one implicit org; any caller may still pass their own Mubit key to bring their own org.

## Calling as a tenant

```bash
curl -s http://localhost:8080/v1/recommend \
  -H "authorization: Bearer mbt_yourinstance_…" \
  -H 'content-type: application/json' \
  -d '{"task":{"task":"…"},"cost_quality_tradeoff":3,"namespace":"prod"}' | jq
```

Or with the SDK:

```python
from minima_client import MinimaClient
minima = MinimaClient("https://api.minima.sh", api_key="mbt_yourinstance_…")
```

A bearer token that is not a well-formed Mubit key (`mbt_…`) returns `401`, as does a
missing key when the server has no `MUBIT_API_KEY` configured. The format check is a cheap
front-door gate only — Minima never validates the key itself; a wrong-but-well-formed key
simply resolves an org whose Mubit calls fail, and `/recommend` degrades to prior-only
recommendations.

`GET /v1/health` is the exception — an unauthenticated probe still gets service liveness,
and a key-bearing probe additionally gets that org's Mubit reachability.

> **Secret hygiene:** Mubit keys are data-plane credentials. Never log or echo them, and
> never commit them — configure the server-side fallback via the `MUBIT_API_KEY` env var
> only.
