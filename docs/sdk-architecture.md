# SDK Architecture — how the Minima loop is encoded in the clients

Minima ships two SDKs that wrap the same `/v1/*` HTTP contract:

- **`@mubit-ai/minima-sdk`** (`packages/sdk/`) — TypeScript, pure `fetch`, zero runtime
  dependencies.
- **`minima_client`** (`client_sdk/minima_client/`) — Python, sync + async, shipped inside
  the `minima-cli` wheel alongside the server.

Both encode the same workflow and the same honesty rules. This page documents their
internal structure and the loop contract they enforce; for task-oriented usage see
[Python Client SDK](client-sdk.md) and [`packages/sdk/README.md`](../packages/sdk/README.md).

## One wire contract, three copies

The server's Pydantic models (`src/minima/schemas/*.py`) are the **wire source of truth**.
Every field lands in three places:

| Copy | Where | Kept honest by |
|------|-------|----------------|
| Server (authoritative) | `src/minima/schemas/*.py` | — |
| TS SDK mirror | `packages/sdk/src/schemas.ts` | `tests/unit/test_ts_mirror.py` (mechanical field-by-field pin) |
| Harness mirror | `packages/tui/src/minima/schemas.ts` | same test |
| Python SDK | *(no copy)* | imports the server's Pydantic models directly (`client.py`) |

The Python client cannot drift because it has no mirror; the two TS mirrors are pinned by
CI. All three version files (`pyproject.toml`, `packages/tui/package.json`,
`packages/sdk/package.json`) move in lockstep on every release.

## The workflow both SDKs encode

```
recommend  →  run the model yourself  →  judge quality  →  feedback
```

Minima is recommend-only: it never proxies, runs, or caches an LLM call. The SDK's job is
to make the four steps of the loop hard to get wrong:

1. **`recommend(task, …)`** — the caller reads `recommendation_id` (the join key for the
   whole loop), `recommended_model.model_id`, `est_cost_usd`, `predicted_success`, and
   `warnings`. `constraints.candidate_models` scopes the choice; `phase` rides as a
   `phase:<value>` tag; `incumbent_model_id` lets the server price prompt-cache stickiness
   honestly. **Recommend never retries** — it fails fast so the caller can fail *open*
   (fall back to a default model rather than block the user's real LLM call).
2. **Run the model yourself**, measuring what the provider actually billed.
3. **Judge quality** — your own gate, judge, or human check. Score thresholds:
   `success >= 0.8`, `partial >= 0.4`, else `failure`.
4. **`feedback(recommendation_id, model_id, outcome, …)`** — carries the **realized**
   `input_tokens` / `output_tokens` / `actual_cost_usd` / `latency_ms`. Never echo
   Minima's own `est_cost_usd` back: real usage is what climbs the cost basis
   `estimate → observed → rescaled`, the single biggest accuracy lever. **Feedback
   retries transparently** (3 attempts) on transport faults and 502/503/504 — the server
   dedupes — but 4xx (including 429) surfaces immediately.

### Label honesty (enforced by field design)

`evidence_source` declares where the outcome label came from, and the server treats each
origin differently:

| `evidence_source` | Meaning | Effect |
|---|---|---|
| `"none"` | no real label | cost/latency **telemetry only** — never touches the success posterior |
| `"judge"` | an LLM judge scored it | teaches the posterior, judge-weighted |
| `"human"` | a person asserted it | teaches the posterior |
| `"gate"` | a deterministic check passed | the **only** origin allowed to claim verified-in-production |

Provider/infra faults should carry `error_cause="infra"` so a rate-limit never reads as
model quality. Per-step results ride as `FeedbackRequest.step_outcomes[]`
(`StepOutcome`: `step_id`, `outcome`, optional `signal` in `[-1, 1]`, `rationale`,
`directive_hint`) — in the harness these are derived exclusively from deterministic/user
gate verdicts, never from model self-assessment.

## Endpoint surface (identical in both SDKs)

| Method (TS / Python) | Endpoint | Purpose |
|---|---|---|
| `recommend` | `POST /v1/recommend` | one-task model pick |
| `recommendWorkflow` / `recommend_workflow` | `POST /v1/recommend/workflow` | per-step picks for a multi-step DAG (`total_est_cost_usd` vs `total_est_cost_if_all_premium`) |
| `feedback` (+ TS `feedbackRaw`) | `POST /v1/feedback` | close the loop with realized usage |
| `savings` | `GET /v1/savings` | realized savings report |
| `calibration` | `GET /v1/calibration` | predicted-vs-realized quality calibration |
| `policyValue` / `policy_value` | `GET /v1/policy-value` | doubly-robust regret-vs-oracle estimate |
| `strategies` | `GET /v1/strategies` | promoted Mubit lessons (explainability) |
| `diagnose` | `POST /v1/diagnose` | failure lessons matching an error text |
| `memoryHealth` / `memory_health` | `GET /v1/memory/health` | per-org memory diagnostics (stale/contradictions/promotion candidates) |
| `models` | `GET /v1/models` | model catalog (cost + capability priors) |
| `capabilities` | `GET /v1/capabilities` | feature handshake (`plan`, `workflow`, `api_version`, `honored_constraints`) |
| `health` | `GET /v1/health` | service/Mubit/catalog status |

## TypeScript SDK internals (`packages/sdk/src/`)

Five files, no runtime deps:

- **`client.ts`** — `MinimaClient`. Constructor options: `baseUrl` (required),
  `apiKey` (→ `Authorization: Bearer`), `feedbackRetryDelaysMs` (default `[500, 2000]`,
  i.e. up to 3 feedback attempts), and an injectable `fetch` for hermetic tests. No
  global timeout — cancellation is per-call via `signal: AbortSignal`. Every request
  sends `x-minima-client` and `user-agent: minima-sdk-ts/<VERSION>`.
  - `feedback()` is the ergonomic camelCase surface (`Usage{inputTokens, outputTokens,
    costUsd, latencyMs}` — explicit `0` is a real measurement); it maps to snake_case
    wire fields and drops undefined.
  - `feedbackRaw(req)` accepts a full `FeedbackRequest` — the seam for advanced fields
    like `step_outcomes` (this is what the harness uses).
- **`schemas.ts`** — the wire mirror: `TaskInput`, `Constraints`, `RecommendRequest/
  Response`, `RankedModel`, `FeedbackRequest/Response`, `StepOutcome`, `WorkflowStep/
  Request/Response`, `SavingsResponse`, `CalibrationResponse`, `PolicyValueResponse`,
  `StrategiesResponse`, `DiagnoseRequest/Response`, `MemoryHealthResponse`,
  `CapabilitiesResponse`, plus the enums (`TASK_TYPES`, `DIFFICULTIES`,
  `OUTCOME_LABELS`, `DECISION_BASES`).
- **`errors.ts`** — typed error ladder: 429 → `MinimaRateLimited` (carries the parsed
  `retry-after` seconds), 502/503/504 → `MinimaUnavailable`, any other non-2xx →
  `MinimaError`; all carry `status` + raw `body`. The retry loop in `feedbackRaw`
  retries **only** `MinimaUnavailable` and transport errors.
- **`index.ts`** — the public surface: `MinimaClient`, the three errors, `VERSION`, and
  `export type *` of the wire types.
- **`version.ts`** — `VERSION` from `package.json`.

## Python SDK internals (`client_sdk/minima_client/`)

- **`client.py`** — `MinimaClient` (sync) and `AsyncMinimaClient` mirror the same
  surface method-for-method; both are context managers. Constructor:
  `(base_url, api_key=None, timeout=10.0)` over `httpx`. Feedback retry uses tenacity
  (`stop_after_attempt(3)`, exponential 0.5s→4s) on `httpx.TransportError` /
  `MinimaUnavailable` only. The typed `Usage` dataclass maps `cost_usd →
  actual_cost_usd` on the wire. Notable defaults that differ from TS: `explain=True`,
  `max_candidates=8`.
- **`errors.py`** — same ladder as TS: `MinimaError` / `MinimaRateLimited` /
  `MinimaUnavailable`.
- **`autocapture.py`** — *not* the feedback loop: a wrapper over `mubit.learn` that pins
  traces to Minima's memory lane (`minima:<namespace>`) by monkeypatching
  OpenAI/Anthropic/LiteLLM/Google clients. Enriches recall; does not produce the
  `kind="outcome"` records the aggregator scores.
- **`integrations/`** — framework adapters (all fail-open, all lazy-import their
  framework):
  - `claude_code.py` — the `minima-route` CLI (`recommend` prints a model id or JSON;
    `feedback` closes the loop from the shell; `--source gate|judge|human|none`).
  - `litellm_router.py` — `MinimaRoutingStrategy` picks the deployment Minima
    recommends (candidates constrained to the model group, in-band correlation via a
    bounded LRU) + `MinimaFeedbackLogger` reports realized cost on success/failure
    events; grader score → outcome via the 0.8/0.4 thresholds, no grader →
    `evidence_source="none"`, failures → `error_cause="infra"`.
  - `openhands_router.py` — `MinimaRouterLLM` routes each completion among
    `llms_for_routing` and fires off-thread telemetry feedback.

Neither client class reads environment variables — explicit `base_url`/`api_key` only.
The one env-aware entry point is the `minima-route` CLI (`MINIMA_URL`,
`MINIMA_API_KEY`/`MUBIT_API_KEY`).

## Known asymmetries (TS vs Python)

| Area | TypeScript | Python |
|---|---|---|
| Timeout | none (per-call `AbortSignal` only) | `timeout=10.0` constructor default |
| `recommend` defaults | `explain`/`max_candidates` unset | `explain=True`, `max_candidates=8` |
| Async | promise-based (inherently async) | separate `AsyncMinimaClient` |
| `step_outcomes` | typed `StepOutcome` + `feedbackRaw` seam | untyped `**kwargs` passthrough only |
| Wire types | hand-mirrored, CI-pinned | imports server Pydantic directly |
| Integrations | none (client only) | litellm, OpenHands, `minima-route` CLI, `autocapture` |
| Feedback retry | fixed delays `[500ms, 2000ms]` | tenacity exponential (0.5s→4s), 3 attempts |
| User-Agent | `minima-sdk-ts/<v>` | `minima-cli/<v> (python-httpx)` |

A note on `cost_basis`: the estimate → observed → rescaled climb is a server-side concept —
there is no `cost_basis` wire field. The observable cousins on `RankedModel` are
`est_cost_breakdown`, `est_cost_low`/`est_cost_high`, `cost_band_basis`, and
`latency_basis`.
