"""Example 2 — The core loop with the Python SDK.

Recommend a model for a task, (pretend to) run it yourself, then feed the outcome back so
the next recommendation is sharper. This is the whole Costit value loop in ~20 lines.

    uv run python examples/02_recommend_and_feedback.py

Set COSTIT_URL (default http://localhost:8080) and, in multi-tenant mode, COSTIT_KEY.
"""

from __future__ import annotations

import os

from costit_client import CostitClient

URL = os.environ.get("COSTIT_URL", "http://localhost:8080")
KEY = os.environ.get("COSTIT_KEY")  # only needed in multi-tenant mode


def main() -> None:
    with CostitClient(URL, api_key=KEY) as costit:
        # 1. Ask which model to use. `task` accepts a plain string, a dict, or a TaskInput.
        rec = costit.recommend(
            {
                "task": "Write a Python function that merges k sorted linked lists.",
                "task_type": "code",
                "difficulty": "hard",
                "expected_input_tokens": 180,
                "expected_output_tokens": 600,
            },
            cost_quality_tradeoff=3,  # lean cheap; 0 = cheapest acceptable, 10 = best quality
        )

        chosen = rec.recommended_model
        print(f"recommended : {chosen.model_id}  (${chosen.est_cost_usd:.5f}/call)")
        print(f"basis       : {rec.decision_basis}  confidence={rec.confidence}")
        print(f"cost basis  : {chosen.est_cost_breakdown}")
        print(f"rationale   : {chosen.rationale}")
        if rec.fallback_model:
            print(f"fallback    : {rec.fallback_model.model_id}")
        if rec.warnings:
            print(f"warnings    : {rec.warnings}")

        # 2. You run `chosen.model_id` in YOUR stack. Costit never calls it for you.
        #    (example 6 shows a real Claude call wired through here.)

        # 3. Tell Costit how it went. Passing realized tokens + cost is what powers the
        #    observed/rescaled cost tiers — do it whenever you have the numbers.
        fb = costit.feedback(
            rec.recommendation_id,
            chosen.model_id,
            "success",
            quality_score=0.95,
            input_tokens=180,
            output_tokens=640,
            actual_cost_usd=0.0034,
            verified_in_production=True,
        )
        print(
            f"\nfeedback    : accepted={fb.accepted} "
            f"reinforced={len(fb.reinforced_entry_ids)} "
            f"lesson_promoted={fb.lesson_promoted} "
            f"reflection={fb.reflection_triggered}"
        )


if __name__ == "__main__":
    main()
