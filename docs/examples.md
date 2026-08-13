# Examples

A guided tour of the runnable examples in [`../examples/`](../examples/), from a single
`curl` to a production routing wrapper. Each script is self-contained and prints what it
needs.

> **Setup.** Start the service (`make run`) against a reachable Mubit instance. Optionally
> seed cold-start memory (`uv run minima-seed --dataset synthetic --limit 2000`) so picks are
> grounded instead of prior-only. Run Python examples with `uv run` from the repo root. Set
> `MINIMA_URL` (default `http://localhost:8080`); when calling a shared deployment also set
> `MINIMA_KEY` (your Mubit `mbt_…` key — auth is pass-through).

## 1. Quickstart with curl — [`01_quickstart.sh`](../examples/01_quickstart.sh)

Exercises the core endpoints (`/health`, `/models`, `/recommend`, `/feedback`,
`/strategies`) with nothing but `curl` and `jq`. The fastest way to confirm a deployment is
wired up. For the reporting endpoints, see [example 7](#7-the-ops-tour--07_observabilitypy).

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
deny-list) and sweeping `cost_quality_tradeoff` from 0→10 to watch Minima walk the
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

`minima_client.autocapture` routes `mubit.learn` into Minima's lane and auto-captures your
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

## 7. The ops tour — [`07_observability.py`](../examples/07_observability.py)

Examples 1–6 all write to Minima; this one only reads. A single pass over every reporting
endpoint, in the order an operator asks: `capabilities` → `savings` (estimated *and*
realized) → `calibration` (is `predicted_success` honest?) → `policy-value` (regret vs. an
oracle) → `memory-health` → `diagnose` (has this error failed before?). On a cold org most
sections are empty; each says so and moves on rather than crashing on a `None`.

```bash
uv run python examples/07_observability.py            # MINIMA_REPORT_DAYS=7 by default
```

## 8. Degrading gracefully — [`08_optional_routing.py`](../examples/08_optional_routing.py)

Routing is an optimization, never a dependency. A `route_or_default()` helper returns your
hardcoded model when Minima is unreachable, feedback is **skipped** when there is no
`recommendation_id` to join on, and feedback failures are swallowed rather than raised into
the hot path. All three arms — healthy, dead port, blown latency budget — run in one pass, so
the fallback is executed rather than described. Note that connection errors and timeouts
arrive as `httpx.HTTPError`, not `MinimaError`; catching only the latter leaves a hole.

```bash
uv run python examples/08_optional_routing.py         # works with the service STOPPED
```

## 9. A/B the savings claim — [`09_ab_savings.py`](../examples/09_ab_savings.py)

The same task set run twice — routed vs. pinned to one premium model — priced on realized
tokens from the same catalog, with cost *and* mean quality per arm so a quality regression
can't hide behind a cost win. The pin is applied as `Constraints(candidate_models=[...])`
before the request, so arm B is a real decision over a one-model pool; re-ranking Minima's
answer client-side instead would break propensity logging and poison `/v1/policy-value`.

```bash
uv run python examples/09_ab_savings.py               # simulated runs, no keys, no spend
ANTHROPIC_API_KEY=sk-ant-... uv run python examples/09_ab_savings.py
```

## TypeScript — [`packages/sdk/examples/quickstart.ts`](../packages/sdk/examples/quickstart.ts)

The same core loop as example 2, with [`@mubit-ai/minima-sdk`](sdk-architecture.md). It
imports from `../src/index.ts`, so it runs straight from a checkout with no publish or
install step.

```bash
bun run packages/sdk/examples/quickstart.ts
```

## Where to go next

- The schemas behind every field: [API Reference](api-reference.md).
- Why the cost numbers move the way they do: [Concepts → Cost-basis tiers](concepts.md#cost-basis-tiers-estimate--observed--rescaled).
- Tuning the engine: [Configuration](configuration.md).
