# Minima Examples

Runnable examples, ordered from simplest to most advanced. Each is self-contained and
documented inline. Full prose docs live in [`../docs/`](../docs/).

> **Prerequisites.** A running Minima service (`make run`) pointed at a reachable Mubit
> instance. The Python examples use the bundled client SDK, so run them with `uv run` from
> the repo root. Set `MINIMA_URL` (default `http://localhost:8080`) and, when calling a
> shared deployment, `MINIMA_KEY` (your Mubit `mbt_…` key — auth is pass-through).

| # | File | Level | What it shows |
|---|------|-------|---------------|
| 1 | [`01_quickstart.sh`](01_quickstart.sh) | Beginner | Raw `curl` against every endpoint — no SDK needed. |
| 2 | [`02_recommend_and_feedback.py`](02_recommend_and_feedback.py) | Beginner | The core loop with the Python SDK: recommend → (run) → feedback. |
| 3 | [`03_constraints_and_tradeoff.py`](03_constraints_and_tradeoff.py) | Intermediate | Constraints, and sweeping the cost/quality slider to see the frontier. |
| 4 | [`04_workflow.py`](04_workflow.py) | Intermediate | Per-step recommendations for a multi-step pipeline + total savings. |
| 5 | [`05_autocapture.py`](05_autocapture.py) | Intermediate | Zero-code intake via `mubit.learn` (no call-site changes). |
| 6 | [`06_routed_llm_call.py`](06_routed_llm_call.py) | Advanced | A reusable wrapper that routes a **real** Claude call and feeds the outcome back. |

## Running

```bash
# 1. start the service (in another terminal)
make run

# 2. (optional) seed cold-start memory so picks are grounded
uv run minima-seed --dataset synthetic --limit 2000 --lane minima:default

# shell example
bash examples/01_quickstart.sh

# python examples
uv run python examples/02_recommend_and_feedback.py
uv run python examples/03_constraints_and_tradeoff.py
uv run python examples/04_workflow.py
```

Examples 5 and 6 need extra credentials (a Mubit key for autocapture; an `ANTHROPIC_API_KEY`
to actually run the routed call). Each script prints what it needs and exits cleanly if
something is missing.
