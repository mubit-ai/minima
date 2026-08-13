"""Example 8 — Minima is optional: degrade gracefully when routing is unavailable.

Every other example assumes the service is up and answers. This one is the shape you
ship: routing is an *optimization*, never a dependency. If Minima is slow, down, or
unreachable, you run your default model and serve the request anyway.

Three rules, all visible below:

  1. A routing failure returns your default model — it never propagates to the caller.
  2. No recommendation_id means NO feedback. `rec_id` is the only join key between your
     run, Minima, and its memory; inventing one or reporting without one corrupts the
     ledger. Skipping is correct.
  3. Feedback failures are logged and swallowed. They must never break the hot path.

The run exercises all three arms so the fallback is actually executed, not just described:
a healthy client, a dead port, and a 1 ms timeout.

    uv run python examples/08_optional_routing.py

This example is *expected to work with the service stopped* — that is the whole point.

Set MINIMA_URL (default http://localhost:8080) and, in multi-tenant mode, MINIMA_KEY.
"""

from __future__ import annotations

import os

import httpx
from minima_client import MinimaClient, MinimaError, Usage

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
KEY = os.environ.get("MINIMA_KEY")  # only needed in multi-tenant mode

# What you run when routing can't answer. Pick the model you'd have hardcoded anyway.
DEFAULT_MODEL = "claude-haiku-4-5"

# Connection errors and timeouts come out of httpx, NOT as MinimaError — MinimaError is
# only raised for HTTP responses the server actually sent. Catch both or the fallback
# has a hole exactly where you need it most.
ROUTING_FAULTS = (MinimaError, httpx.HTTPError)


def route_or_default(
    minima: MinimaClient, task: str, default_model: str
) -> tuple[str, str | None]:
    """(model_id, recommendation_id) — falls back to default_model with no rec_id."""
    try:
        rec = minima.recommend(task, cost_quality_tradeoff=5.0)
        return rec.recommended_model.model_id, rec.recommendation_id
    except ROUTING_FAULTS as exc:
        print(f"    routing unavailable ({type(exc).__name__}) — falling back")
        return default_model, None


def report(
    minima: MinimaClient, rec_id: str | None, model_id: str, quality: float, usage: Usage
) -> None:
    """Close the loop when there is something to close it against; never raise."""
    if rec_id is None:
        print("    feedback skipped — no recommendation_id to join on")
        return
    outcome = "success" if quality >= 0.8 else "partial" if quality >= 0.4 else "failure"
    try:
        minima.feedback(rec_id, model_id, outcome, usage, quality_score=quality)
        print(f"    feedback sent: {outcome}")
    except ROUTING_FAULTS as exc:
        # Swallowed on purpose. The user already got their answer; losing a feedback
        # row costs a little future accuracy, and that is strictly better than a 500.
        print(f"    feedback failed, ignoring ({type(exc).__name__}: {exc})")


def run_model(model_id: str, task: str) -> tuple[str, Usage, float]:
    """Stand-in for your actual inference call. Returns (text, realized usage, quality)."""
    usage = Usage(
        input_tokens=max(1, len(task) // 4),
        output_tokens=180,
        cost_usd=0.00042,  # what your provider ACTUALLY billed — never Minima's estimate
        latency_ms=900,
    )
    return f"[output from {model_id}]", usage, 0.9


def serve(label: str, minima: MinimaClient, task: str) -> None:
    print(f"\n== {label} ==")
    model_id, rec_id = route_or_default(minima, task, DEFAULT_MODEL)
    print(f"    running {model_id}" + ("" if rec_id else "  (default)"))
    _text, usage, quality = run_model(model_id, task)
    report(minima, rec_id, model_id, quality, usage)
    print("    request served ✓")


def main() -> None:
    task = "Summarize this support thread in two sentences."

    # (a) the happy path — routing answers, feedback lands
    with MinimaClient(URL, api_key=KEY) as minima:
        serve(f"healthy service ({URL})", minima, task)

    # (b) service down — port 9 is the discard port, nothing ever listens there
    with MinimaClient("http://127.0.0.1:9") as minima:
        serve("service unreachable", minima, task)

    # (c) service up but too slow for your latency budget
    with MinimaClient(URL, api_key=KEY, timeout=0.001) as minima:
        serve("routing budget exceeded (1ms timeout)", minima, task)

    print("\nall three arms served a response. Routing is an optimization, not a dependency.")


if __name__ == "__main__":
    main()
