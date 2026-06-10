"""Example 4 — Per-step recommendations for a multi-step workflow.

Many agent pipelines run several LLM steps of very different difficulty. A cheap model can
often handle extraction/classification while a stronger one handles the hard reasoning step.
`POST /v1/recommend/workflow` runs the same engine per step and reports the total estimated
cost versus the all-premium baseline — the headline savings for the whole pipeline.

Each step gets its OWN recommendation_id (inside `step.recommendation`), so you give
per-step feedback after running each step.

    uv run python examples/04_workflow.py
"""

from __future__ import annotations

import os

from costit_client import CostitClient

from costit.schemas.common import Constraints, TaskInput
from costit.schemas.workflow import WorkflowRequest, WorkflowStep

URL = os.environ.get("COSTIT_URL", "http://localhost:8080")
KEY = os.environ.get("COSTIT_KEY")


def main() -> None:
    req = WorkflowRequest(
        cost_quality_tradeoff=4,
        # A global cost ceiling that every step inherits unless it overrides.
        constraints=Constraints(max_cost_per_call=0.05),
        namespace="support-triage",
        steps=[
            WorkflowStep(
                step_id="classify",
                task=TaskInput(task="Classify this support ticket's category and urgency.",
                               task_type="classification", difficulty="easy"),
            ),
            WorkflowStep(
                step_id="extract",
                task=TaskInput(task="Extract the customer's account id, product, and error "
                                    "code from the ticket.",
                               task_type="extraction", difficulty="medium"),
            ),
            WorkflowStep(
                step_id="resolve",
                task=TaskInput(task="Given the ticket and our KB, draft a root-cause analysis "
                                    "and a step-by-step fix.",
                               task_type="reasoning", difficulty="hard"),
                # This hard step is worth more quality + a bigger budget than the global one.
                constraints=Constraints(min_quality=0.85, max_cost_per_call=0.20),
            ),
        ],
    )

    with CostitClient(URL, api_key=KEY) as costit:
        wf = costit.recommend_workflow(req)

        print(f"workflow {wf.workflow_recommendation_id}  confidence={wf.confidence}\n")
        print(f"  {'step':<10} {'model':<28} {'$/call':>10} {'basis':<7}")
        for step in wf.steps:
            m = step.recommendation.recommended_model
            print(f"  {step.step_id:<10} {m.model_id:<28} {m.est_cost_usd:>10.5f} "
                  f"{step.recommendation.decision_basis:<7}")

        savings = wf.total_est_cost_if_all_premium - wf.total_est_cost_usd
        pct = (savings / wf.total_est_cost_if_all_premium * 100
               if wf.total_est_cost_if_all_premium else 0.0)
        print(f"\n  total (Costit picks) : ${wf.total_est_cost_usd:.5f}")
        print(f"  total (all premium)  : ${wf.total_est_cost_if_all_premium:.5f}")
        print(f"  estimated savings    : ${savings:.5f}  ({pct:.0f}%)")

        # Give per-step feedback after you run each step, using its own recommendation_id:
        #   for step in wf.steps:
        #       costit.feedback(step.recommendation.recommendation_id,
        #                       step.recommendation.recommended_model.model_id,
        #                       "success", quality_score=..., input_tokens=..., ...)


if __name__ == "__main__":
    main()
