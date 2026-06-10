"""Example 6 — A production wrapper that routes a REAL Claude call and feeds it back.

This is the shape you'd actually ship: a loop that, for each task,
  1. asks Minima which model to use,
  2. runs that model on YOUR stack (here, via the Anthropic SDK),
  3. reports the realized outcome — tokens, cost, quality — back to Minima.

It uses the async client (so it drops into an async service unchanged) and degrades
gracefully: if the recommended model isn't an Anthropic model, or no ANTHROPIC_API_KEY is
set, it simulates the run so the routing + feedback loop is still demonstrated.

    ANTHROPIC_API_KEY=sk-ant-... uv run python examples/06_routed_llm_call.py
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

from minima_client import AsyncMinimaClient, MinimaError

from minima.schemas.common import Constraints

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
KEY = os.environ.get("MINIMA_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")


@dataclass
class RunResult:
    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


def _price(catalog, model_id: str) -> tuple[float, float]:
    """(input $/Mtok, output $/Mtok) for a model from the catalog; (0,0) if unknown."""
    for card in catalog.models:
        if card.model_id == model_id:
            return card.input_cost_per_mtok, card.output_cost_per_mtok
    return 0.0, 0.0


def _run_anthropic(model_id: str, prompt: str) -> RunResult:
    """Run the chosen model via the official Anthropic SDK and capture real usage."""
    from anthropic import Anthropic  # imported lazily; only when we actually run

    started = time.monotonic()
    client = Anthropic(api_key=ANTHROPIC_KEY)
    # Stream for long output so we never hit a request timeout, then collect the final message.
    with client.messages.stream(
        model=model_id,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        msg = stream.get_final_message()
    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    return RunResult(
        text=text,
        input_tokens=msg.usage.input_tokens,
        output_tokens=msg.usage.output_tokens,
        latency_ms=int((time.monotonic() - started) * 1000),
    )


def _simulate(model_id: str, prompt: str) -> RunResult:
    return RunResult(text=f"[simulated output from {model_id}]",
                     input_tokens=max(1, len(prompt) // 4), output_tokens=180, latency_ms=900)


def grade(text: str) -> float:
    """Your real quality signal goes here (tests pass, eval rubric, human rating, ...)."""
    return 0.95 if text and "[simulated" not in text else 0.7


async def main() -> None:
    async with AsyncMinimaClient(URL, api_key=KEY) as minima:
        try:
            catalog = await minima.models(provider="anthropic")
        except MinimaError as exc:
            print(f"could not reach Minima at {URL}: {exc}")
            return

        prompts = [
            ("Extract the order id and total from: 'Order #A-9931 totalling $48.20 shipped.'",
             "extraction", 2.0),
            ("Design a retry policy with jitter for a flaky payment webhook; justify the math.",
             "reasoning", 7.0),
        ]

        for prompt, task_type, slider in prompts:
            print(f"\n• task ({task_type}, slider {slider}): {prompt[:60]}…")
            rec = await minima.recommend({"task": prompt, "task_type": task_type},
                                         cost_quality_tradeoff=slider,
                                         constraints=Constraints(allowed_providers=["anthropic"]))
            model = rec.recommended_model.model_id
            print(f"  routed to {model} (basis={rec.decision_basis}, "
                  f"est ${rec.recommended_model.est_cost_usd:.5f})")

            can_run = bool(ANTHROPIC_KEY) and rec.recommended_model.provider.lower() == "anthropic"
            result = _run_anthropic(model, prompt) if can_run else _simulate(model, prompt)
            if not can_run:
                print("  (set ANTHROPIC_API_KEY to actually run the call; simulating)")

            in_p, out_p = _price(catalog, model)
            actual_cost = result.input_tokens / 1e6 * in_p + result.output_tokens / 1e6 * out_p
            quality = grade(result.text)

            fb = await minima.feedback(
                rec.recommendation_id, model,
                "success" if quality >= 0.8 else "partial",
                quality_score=quality,
                input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                actual_cost_usd=round(actual_cost, 8), latency_ms=result.latency_ms,
                verified_in_production=True,
            )
            print(f"  ran: {result.input_tokens}->{result.output_tokens} tok, "
                  f"${actual_cost:.5f}, quality {quality:.2f} | feedback accepted={fb.accepted}")


if __name__ == "__main__":
    asyncio.run(main())
