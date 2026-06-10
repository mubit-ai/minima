# Multi-Tenancy

One Costit deployment can serve many organizations, each backed by **its own Mubit
instance**, with per-org API keys. This is off by default; when off, Costit runs
single-tenant against one env-configured Mubit instance.

## The model

- **Tenant boundary = the Costit key → a Mubit instance.** Each org provides its own Mubit
  instance once at onboarding. Callers authenticate with a Costit-issued key
  (`cstk_<org>_<keyid>_<secret>`) that resolves server-side to that org's Mubit instance.
  **The org's Mubit key is never sent per call.**
- **`namespace` and `user_id` are intra-org** sub-scoping, not tenant boundaries.
- **State is org-scoped.** Recommendation store and propensity tracking are partitioned by
  org, so a `recommendation_id` minted for one org resolves to nothing for another — orgs
  cannot credit or poison each other's learning.
- **The provisioning key is the admin credential** (LiteLLM master-key model). It mints and
  manages per-org keys and is never handed to callers.

## Enabling it

```bash
COSTIT_MULTITENANT=true
COSTIT_PROVISIONING_KEY=<long-random-secret>     # required; admin credential
COSTIT_TENANT_STORE=sqlite                       # durable registry (or "memory")
COSTIT_TENANT_STORE_PATH=costit_tenants.db
# Leave MUBIT_API_KEY blank — each org's key is resolved from the registry.
```

When multi-tenant is on, `MUBIT_API_KEY` is unused; `/recommend`, `/feedback`, and
`/strategies` require `Authorization: Bearer cstk_…`; and the `/v1/admin/tenants`
endpoints become active.

## Provisioning a tenant

Mint an org and its first Costit key. The full key is returned **once** at creation — only a
hash is persisted and it cannot be recovered later.

```bash
curl -s -X POST http://localhost:8080/v1/admin/tenants \
  -H "x-costit-provisioning-key: $COSTIT_PROVISIONING_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "org_id": "acme",
        "mubit_endpoint": "https://acme.mubit.example",
        "mubit_api_key_ref": "env:ACME_MUBIT_KEY",
        "mubit_transport": "http"
      }' | jq
```

### `TenantCreateRequest`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `org_id` | string | required | 1–63 chars `[a-z0-9-]`, starts alphanumeric. |
| `mubit_endpoint` | string | required | The org's own Mubit instance URL. |
| `mubit_api_key_ref` | string | required | Reference to the org's Mubit data-plane key: `env:NAME` (recommended), `inline:VALUE` (dev only), or `vault:path` (future). The raw key is never stored in the clear with a real backend. |
| `mubit_transport` | string | `http` | `http` \| `grpc` \| `auto`. |
| `lane_prefix` | string | `costit` | Intra-org lane prefix. |
| `reads_shared_seed` | bool | `false` | Reserved: read a Costit-owned warm-start reference instance. |

### `TenantCreateResponse`

`{ org_id, key_id, costit_api_key, created_at }` — `costit_api_key` is the full
`cstk_…` secret, shown only here. Store it securely and hand it to the org.

> **Secret hygiene:** prefer `mubit_api_key_ref: "env:NAME"` so the org's Mubit key lives in
> the deployment environment, not the registry. Never log or echo `cstk_…` keys or Mubit
> keys.

## Listing and revoking

```bash
# List (summaries only — no secrets)
curl -s http://localhost:8080/v1/admin/tenants \
  -H "x-costit-provisioning-key: $COSTIT_PROVISIONING_KEY" | jq

# Revoke (re-key by deleting then re-creating)
curl -s -X DELETE http://localhost:8080/v1/admin/tenants/acme \
  -H "x-costit-provisioning-key: $COSTIT_PROVISIONING_KEY" | jq
```

Re-creating an existing `org_id` returns `409` — delete it first to re-key.

## Calling as a tenant

Once provisioned, the org calls the normal endpoints with its Costit key:

```bash
curl -s http://localhost:8080/v1/recommend \
  -H "authorization: Bearer cstk_acme_…" \
  -H 'content-type: application/json' \
  -d '{"task":{"task":"…"},"cost_quality_tradeoff":3,"namespace":"prod"}' | jq
```

Or with the SDK:

```python
from costit_client import CostitClient
costit = CostitClient("https://costit.example", api_key="cstk_acme_…")
```

A missing or invalid key returns `401`. `GET /v1/health` is the exception — an
unauthenticated probe still gets service liveness, and a key-bearing probe additionally gets
that org's Mubit reachability.

See [`examples/07_multitenant_admin.py`](../examples/07_multitenant_admin.py) for an
end-to-end provision-then-call script.
