# Minima Documentation

Minima recommends a cheaper or alternate LLM model for a given task, so LLM-driven
workflows spend fewer tokens without losing the quality the task actually needs. It is a
**recommend-only** advice layer backed by [Mubit](https://docs.mubit.ai) memory — it never
proxies a call, runs a model, rewrites a prompt, or caches, so it adds **zero latency** to
your real LLM call.

## Start here

- **[Getting Started](getting-started.md)** — install, configure, run, and make your first
  recommendation in under five minutes.
- **[Concepts](concepts.md)** — the recommend → run → feedback loop, the recommendation
  algorithm, the cost-basis tiers (estimate → observed → rescaled), escalation, and how
  Minima gets sharper over time.

## Reference

- **[API Reference](api-reference.md)** — every endpoint, full request/response schemas,
  field semantics, warnings, and error formats.
- **[Configuration](configuration.md)** — every environment variable, defaults, and tuning
  guidance.
- **[Python Client SDK](client-sdk.md)** — the `minima_client` package: sync/async clients
  and the zero-code `autocapture` intake.
- **[SDK Architecture](sdk-architecture.md)** — how both SDKs (TypeScript + Python) encode
  the loop: wire-contract mirroring, retry/error discipline, label honesty, and the
  known asymmetries between the two.
- **[Harness Architecture](harness-architecture.md)** — the internal agentic structure of
  the `minima` CLI (`packages/tui`): the turn lifecycle, hook stacks, sub-agent DAG,
  budget ledger, recovery ladder, Big Plan spine (formerly ground-truth), memory ledger, and DB spine.
- **[Feedback-Loop Research](feedback-loop-research.md)** — 2023–2026 literature survey
  (bandits/OPE, label quality, memory/credit assignment) mapped to the implemented loop,
  with a phased improvement roadmap.
- **[Observer-Agent Research](observer-agent-research.md)** — evidence and design fit for
  a parallel adversarial observer agent: trusted-monitoring literature, industry practice,
  harness attachment points, and a phased O1–O5 plan.

## Guides

- **[Cold-Start Seeding](seeding.md)** — load `task → model → outcome` history so day-one
  recommendations are grounded instead of guessing.
- **[Multi-Tenancy](multi-tenancy.md)** — run one Minima deployment for many organizations,
  each on its own Mubit instance, with per-org API keys.
- **[Operations](operations.md)** — deployment, health checks, degradation behavior,
  catalog refresh, and what to monitor.

## Examples

Runnable, progressively more advanced examples live in **[`../examples/`](../examples/)**.
See **[Examples](examples.md)** for a guided tour, or jump straight to:

| # | Example | What it shows |
|---|---------|---------------|
| 1 | [`01_quickstart.sh`](../examples/01_quickstart.sh) | Raw `curl` against every endpoint |
| 2 | [`02_recommend_and_feedback.py`](../examples/02_recommend_and_feedback.py) | The core loop with the Python SDK |
| 3 | [`03_constraints_and_tradeoff.py`](../examples/03_constraints_and_tradeoff.py) | Constraints + sweeping the cost/quality slider |
| 4 | [`04_workflow.py`](../examples/04_workflow.py) | Per-step recommendations for a multi-step pipeline |
| 5 | [`05_autocapture.py`](../examples/05_autocapture.py) | Zero-code intake via `mubit.learn` |
| 6 | [`06_routed_llm_call.py`](../examples/06_routed_llm_call.py) | A production wrapper that routes a real Claude call and feeds the outcome back |
| 7 | [`07_multitenant_admin.py`](../examples/07_multitenant_admin.py) | Provision an org, then call as that tenant |

## At a glance

```
POST /v1/recommend            recommend a model for one task
POST /v1/recommend/workflow   recommend a model per step of a workflow
POST /v1/feedback             report an outcome, close the learning loop
GET  /v1/models               the current model catalog (cost + capability priors)
GET  /v1/strategies           rules Mubit has promoted for a namespace (explainability)
GET  /v1/health               service, Mubit, catalog, and reasoner status
POST /v1/admin/tenants        provision a tenant (multi-tenant mode only)
```
