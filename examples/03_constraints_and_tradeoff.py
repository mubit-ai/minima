"""Example 3 — Constraints and the cost/quality slider.

Two things every real integration needs:

  1. Constraints — hard limits on which models are even eligible (providers, cost ceiling,
     quality floor, prompt-caching, context window, explicit allow/deny lists).
  2. The cost_quality_tradeoff slider (0..10) — sweep it to see Minima walk the
     cost-vs-quality frontier for the SAME task.

    uv run python examples/03_constraints_and_tradeoff.py
"""

from __future__ import annotations

import os

from minima_client import MinimaClient

from minima.schemas.common import Constraints, TaskInput

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
KEY = os.environ.get("MINIMA_KEY")

TASK = TaskInput(
    task="Refactor this recursive descent parser to an iterative one with memoization.",
    task_type="code",
    difficulty="hard",
    expected_input_tokens=1200,
    expected_output_tokens=900,
    tags=["lang:python"],
)


def main() -> None:
    with MinimaClient(URL, api_key=KEY) as minima:
        # --- Constraints: only Anthropic/Google models, must clear 0.8 predicted success,
        #     no more than $0.05/call, and never route to a model we've blacklisted. ---
        constraints = Constraints(
            allowed_providers=["anthropic", "google"],
            min_quality=0.8,
            max_cost_per_call=0.05,
            excluded_models=["some-deprecated-model"],
        )
        rec = minima.recommend(TASK, cost_quality_tradeoff=5, constraints=constraints)
        print("== constrained recommendation ==")
        print(f"  picked {rec.recommended_model.model_id} "
              f"(${rec.recommended_model.est_cost_usd:.5f}, basis={rec.decision_basis})")
        print(f"  considered: {[m.model_id for m in rec.ranked]}")

        # --- Slider sweep: same task, watch the recommended model + cost move as we go
        #     from 'cheapest acceptable' (0) to 'highest quality' (10). ---
        print("\n== cost/quality frontier (slider sweep) ==")
        print(f"  {'slider':>6} {'model':<28} {'pred':>6} {'$/call':>10} {'τ':>6}")
        for slider in (0, 2, 4, 6, 8, 10):
            r = minima.recommend(TASK, cost_quality_tradeoff=slider)
            m = r.recommended_model
            print(f"  {slider:>6} {m.model_id:<28} {m.predicted_success:>6.2f} "
                  f"{m.est_cost_usd:>10.5f} {r.threshold_used:>6.2f}")

        print("\nLower slider -> cheaper model clears a lower bar; higher slider -> Minima "
              "spends more to clear a higher bar. The same engine, one knob.")


if __name__ == "__main__":
    main()
