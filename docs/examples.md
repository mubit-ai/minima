# Examples

A guided tour of the runnable examples in [`../examples/`](../examples/), from a single
`curl` to a production routing wrapper and tenant provisioning. Each script is
self-contained and prints what it needs.

> **Setup.** Start the service (`make run`) against a reachable Mubit instance. Optionally
> seed cold-start memory (`uv run costit-seed --dataset synthetic --limit 2000`) so picks are
> grounded instead of prior-only. Run Python examples with `uv run` from the repo root. Set
> `COSTIT_URL` (default `http://localhost:8080`); in multi-tenant mode also set `COSTIT_KEY`.

## 1. Quickstart with curl — [`01_quickstart.sh`](../examples/01_quickstart.sh)

Exercises every endpoint (`/health`, `/models`, `/recommend`, `/feedback`, `/strategies`)
with nothing but `curl` and `jq`. The fastest way to confirm a deployment is wired up.

```bash
bash examples/01_quickstart.sh
```

## 2. The core loop — [`02_recommend_and_feedback.py`](../examples/02_recommend_and_feedback.py)

The whole value loop with the Python SDK: recommend → (you run the model) → feedback. Shows
the flexible `task` input (string / dict / `TaskInput`), reading the recommendation and its
cost basis, and reporting realized tokens + cost so the cost ranking improves.

```bash
uv run python examples/02_recommend_and_feedback.py
```

## 3. Constraints + the slider — [`03_constraints_and_tradeoff.py`](../examples/03_constraints_and_tradeoff.py)

Two everyday needs: hard `Constraints` (provider whitelist, quality floor, cost ceiling,
deny-list) and sweeping `cost_quality_tradeoff` from 0→10 to watch Costit walk the
cost-vs-quality frontier for the same task.

```bash
uv run python examples/03_constraints_and_tradeoff.py
```

## 4. Multi-step workflow — [`04_workflow.py`](../examples/04_workflow.py)

`POST /v1/recommend/workflow` routes each step of a pipeline independently — a cheap model
for classify/extract, a stronger one for the hard reasoning step — and reports total cost
versus the all-premium baseline. Per-step `recommendation_id`s let you give per-step
feedback.

```bash
uv run python examples/04_workflow.py
```

## 5. Zero-code intake — [`05_autocapture.py`](../examples/05_autocapture.py)

`costit_client.autocapture` routes `mubit.learn` into Costit's lane and auto-captures your
existing LLM calls with no call-site changes. Demonstrates `enable()`, manual `capture()`
for raw HTTP, the explicit `feedback()` that closes the loop, and `disable()`. Needs a Mubit
key.

```bash
MUBIT_API_KEY=<key> uv run python examples/05_autocapture.py
```

## 6. Production routing wrapper — [`06_routed_llm_call.py`](../examples/06_routed_llm_call.py)

The shape you'd ship: an async helper that recommends a model, runs it via the official
**Anthropic SDK** (streaming, real token usage), and feeds the realized cost/quality back.
Degrades to a simulated run if `ANTHROPIC_API_KEY` is unset, so the routing + feedback loop
still demonstrates end to end.

```bash
ANTHROPIC_API_KEY=sk-ant-... uv run python examples/06_routed_llm_call.py
```

## 7. Multi-tenant provisioning — [`07_multitenant_admin.py`](../examples/07_multitenant_admin.py)

Provisions an org through the admin API (raw `httpx`), captures the one-time `cstk_…` key,
lists tenants, then calls the normal API as that tenant with the SDK. Requires the service
started in multi-tenant mode with a provisioning key.

```bash
# service: COSTIT_MULTITENANT=true COSTIT_PROVISIONING_KEY=secret uvicorn costit.main:app
COSTIT_PROVISIONING_KEY=secret uv run python examples/07_multitenant_admin.py
```

## Where to go next

- The schemas behind every field: [API Reference](api-reference.md).
- Why the cost numbers move the way they do: [Concepts → Cost-basis tiers](concepts.md#cost-basis-tiers-estimate--observed--rescaled).
- Tuning the engine: [Configuration](configuration.md).
