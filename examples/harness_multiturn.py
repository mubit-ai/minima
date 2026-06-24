"""Phase 7 demo — a custom AgentTool + a multi-turn task, hermetically.

Shows the full route -> run -> judge -> feedback loop with a tool that needs >1 turn:

  turn 1  the model calls `calc` (our custom AgentTool)  ->  tool returns the result
  turn 2  the model emits the final answer               ->  judge scores it

`turns_taken` (here 2) flows into feedback as `iterations`, so a cheap-but-many-turns model
ranks worse than one that resolves the task in one shot (iterations-based routing).

Zero cost: in-process routing (FakeRouter) + the faux provider (scripted responses). No real
Minima, no LLM API keys. Mirrors the hermetic pattern in tests/harness/test_runtime.py.

    uv run python examples/harness_multiturn.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from minima_harness.ai import AssistantMessage, TextContent, ToolCall  # noqa: E402
from minima_harness.ai.providers import register_faux_provider  # noqa: E402
from minima_harness.minima import (  # noqa: E402
    HarnessConfig,
    MinimaAgent,
    ModelMapping,
    RoutingResult,
)
from minima_harness.minima.judge import DeterministicJudge  # noqa: E402
from minima_harness.tools import calc_tool  # noqa: E402


class FakeRouter:
    """Captures recommend/feedback so the demo can print what flowed back to Minima."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.mapping = ModelMapping()
        self.feedback_calls: list[dict[str, Any]] = []

    async def recommend(self, task, *, task_type=None, slider=None, **_: Any) -> RoutingResult:
        return RoutingResult(
            recommendation_id="rec-demo",
            chosen_model_id="faux",
            model=self.model,
            est_cost_usd=0.0008,
            decision_basis="memory",
        )

    async def feedback(
        self,
        rec_id: str,
        chosen: str,
        outcome: str,
        *,
        quality: float | None,
        usage: Any,
        latency_ms: int,
        iterations: int | None = None,
    ) -> None:
        self.feedback_calls.append(
            {
                "rec_id": rec_id,
                "chosen": chosen,
                "outcome": outcome,
                "quality": quality,
                "output_tokens": usage.output,
                "cost": usage.cost.total,
                "latency_ms": latency_ms,
                "iterations": iterations,
            }
        )


def _tool_call(expr: str) -> AssistantMessage:
    return AssistantMessage(
        content=[ToolCall(id="c1", name="calc", arguments={"expression": expr})],
        stop_reason="toolUse",
    )


def _final_answer(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextContent(text=text)], stop_reason="stop")


async def run_demo(expr: str, expected: str) -> None:
    print("[demo] in-process routing (FakeRouter) + faux provider + calc tool — no keys\n")
    with register_faux_provider() as reg:
        reg.set_responses([_tool_call(expr), _final_answer(f"{expr} = {expected}")])
        faux_model = reg.get_model()
        router = FakeRouter(faux_model)
        agent = MinimaAgent(
            HarnessConfig(candidates=["faux"], judge_every=1),
            router=router,
            judge=DeterministicJudge(lambda t: 0.9),
            model=faux_model,
            tools=[calc_tool()],
            task_type="reasoning",
        )

        print(f"prompt: 'Use calc to compute {expr}, then give the answer.'")
        await agent.prompt(f"Use calc to compute {expr}, then give the answer.")

    print(f"\nturns_taken: {agent.state.turns_taken}")
    print(f"final answer: {agent._last_assistant().text}")  # noqa: SLF001
    print(f"calc tool registered: yes (name={calc_tool().name})")

    fb = router.feedback_calls[0]
    print("\nfeedback sent to Minima:")
    for k in ("outcome", "quality", "output_tokens", "cost", "latency_ms", "iterations"):
        print(f"  {k:<14} {fb[k]}")
    print(
        "\niterations == turns_taken; feed this back so a model that resolves in fewer turns"
        "\nranks above a cheaper one that burns many tool round-trips.\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--expr", default="17 * 23", help="expression for calc to evaluate")
    ap.add_argument("--expected", default="391", help="canned final answer text")
    args = ap.parse_args()
    asyncio.run(run_demo(args.expr, args.expected))
    return 0


if __name__ == "__main__":
    sys.exit(main())
