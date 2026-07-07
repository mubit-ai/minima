"""Gemini routing agent — routes tasks across the full Gemini model spectrum via Minima.

Sends text and reasoning tasks through Minima's recommender, executes them on the
chosen Gemini model, reports feedback so Minima learns, and prints a result table.

Setup:
    uv sync --extra reasoner-gemini
    GEMINI_API_KEY=... MINIMA_URL=http://localhost:8088 uv run python examples/agent_gemini.py
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field

from google import genai
from google.genai import types

from minima_client import AsyncMinimaClient
from minima.schemas.common import Constraints

MINIMA_URL = os.environ.get("MINIMA_URL", "http://localhost:8088")
MINIMA_KEY = os.environ.get("MINIMA_KEY")
GEMINI_KEY = os.environ["GEMINI_API_KEY"]

# Full Gemini spectrum — cheapest → most expensive.
# Minima picks among these based on task difficulty + memory.
GEMINI_MODELS = [
    "gemini-2.5-flash-lite",       # fastest / cheapest
    "gemini-3.1-flash-lite",       # cheap, stable
    "gemini-2.5-flash",            # best price-perf, stable
    "gemini-3-flash-preview",      # frontier at lower cost
    "gemini-3.5-flash",            # best for agentic / coding
    "gemini-2.5-pro",              # deep reasoning, stable
    "gemini-3.1-pro-preview",      # complex reasoning, preview
]


@dataclass
class Task:
    prompt: str
    task_type: str          # maps to Minima's TaskType
    slider: float           # 1=cheapest-acceptable … 10=highest-quality
    quality_fn: object      # (output: str) -> float in [0,1]
    label: str = field(default="")

    def __post_init__(self):
        if not self.label:
            self.label = f"{self.task_type}:{self.prompt[:40]}"


# ---------------------------------------------------------------------------
# Task set — Text (low–mid slider) + Reasoning (high slider)
# ---------------------------------------------------------------------------
TASKS = [
    # --- Text ---
    Task(
        label="extraction",
        task_type="extraction",
        slider=2.5,
        prompt=(
            "Extract customer name, order number, and total amount from this text.\n"
            "Text: 'Hi, I'm Sarah Johnson. My order #ORD-77821 for $134.99 hasn't arrived yet.'"
        ),
        quality_fn=lambda t: 1.0 if all(x in t for x in ["Sarah Johnson", "ORD-77821", "134.99"]) else 0.3,
    ),
    Task(
        label="summarization",
        task_type="summarization",
        slider=4.0,
        prompt=(
            "Summarize in exactly one sentence:\n"
            "'The transformer architecture, introduced in the 2017 paper Attention Is All You Need, "
            "replaced recurrent networks with self-attention mechanisms, enabling parallel processing "
            "of sequences and dramatically improving performance on NLP tasks.'"
        ),
        quality_fn=lambda t: 0.9 if 10 < len(t.split()) < 50 else 0.4,
    ),
    Task(
        label="classification",
        task_type="classification",
        slider=3.0,
        prompt=(
            "Classify as Positive, Negative, or Neutral:\n"
            "'The product arrived on time and works as described. Nothing exceptional but no complaints either.'"
        ),
        quality_fn=lambda t: 1.0 if "neutral" in t.lower() else 0.0,
    ),
    # --- Reasoning ---
    Task(
        label="math",
        task_type="reasoning",
        slider=6.5,
        prompt=(
            "A rectangle has a perimeter of 56 cm. Its length is 3 times its width. "
            "What is its area in cm²? Show your working."
        ),
        # width=7, length=21, area=147
        quality_fn=lambda t: 1.0 if "147" in t else 0.2,
    ),
    Task(
        label="logic-ordering",
        task_type="reasoning",
        slider=7.5,
        prompt=(
            "Alice is taller than Bob. Bob is taller than Carol. "
            "David is shorter than Carol but taller than Eve. "
            "List everyone from tallest to shortest."
        ),
        # Alice > Bob > Carol > David > Eve
        quality_fn=lambda t: (
            1.0 if t.lower().index("alice") < t.lower().index("eve") else 0.2
        ) if "alice" in t.lower() and "eve" in t.lower() else 0.0,
    ),
    Task(
        label="code-sieve",
        task_type="code",
        slider=7.0,
        prompt="Write a Python function that returns all prime numbers up to n using the Sieve of Eratosthenes.",
        quality_fn=lambda t: 1.0 if "def " in t and "return" in t and "[" in t else 0.4,
    ),
    Task(
        label="multi-step-reasoning",
        task_type="reasoning",
        slider=9.0,
        prompt=(
            "A store sells apples at $0.50 each and oranges at $0.75 each. "
            "A customer buys some apples and oranges for exactly $5.00 total. "
            "List all possible combinations (number of apples, number of oranges)."
        ),
        # Valid: (10,0),(7,2),(4,4),(1,6)
        quality_fn=lambda t: 1.0 if "10" in t and "6" in t else 0.3,
    ),
]


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------

def call_gemini(model_id: str, prompt: str) -> tuple[str, int, int, int]:
    """Returns (text, input_tokens, output_tokens, latency_ms)."""
    client = genai.Client(api_key=GEMINI_KEY)
    t0 = time.monotonic()
    response = client.models.generate_content(
        model=model_id,
        contents=prompt,
        config=types.GenerateContentConfig(
            max_output_tokens=1024,
            temperature=0.0,
        ),
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    text = response.text or ""
    usage = response.usage_metadata
    return (
        text,
        usage.prompt_token_count or 0,
        usage.candidates_token_count or 0,
        latency_ms,
    )


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

async def run_task(minima: AsyncMinimaClient, task: Task, prices: dict) -> dict:
    # 1. Ask Minima which Gemini model to use
    rec = await minima.recommend(
        {"task": task.prompt, "task_type": task.task_type},
        cost_quality_tradeoff=task.slider,
        constraints=Constraints(candidate_models=GEMINI_MODELS),
    )
    model = rec.recommended_model.model_id

    # 2. Call that model
    text, in_tok, out_tok, latency_ms = call_gemini(model, task.prompt)

    # 3. Score quality with your task-specific function
    quality = float(task.quality_fn(text))

    # 4. Compute actual cost from catalog prices
    in_p, out_p = prices.get(model, (0.0, 0.0))
    actual_cost = in_tok / 1e6 * in_p + out_tok / 1e6 * out_p

    # 5. Report back — this is what Minima learns from
    await minima.feedback(
        rec.recommendation_id,
        model,
        "success" if quality >= 0.8 else ("partial" if quality >= 0.4 else "failure"),
        quality_score=quality,
        input_tokens=in_tok,
        output_tokens=out_tok,
        actual_cost_usd=round(actual_cost, 8),
        latency_ms=latency_ms,
        verified_in_production=True,
    )

    return {
        "label": task.label,
        "task_type": task.task_type,
        "slider": task.slider,
        "model": model,
        "basis": rec.decision_basis,
        "quality": quality,
        "cost_usd": actual_cost,
        "latency_ms": latency_ms,
    }


async def main() -> None:
    async with AsyncMinimaClient(MINIMA_URL, api_key=MINIMA_KEY) as minima:
        # Load prices from Minima's catalog (source of truth)
        catalog = await minima.models(provider="google")
        prices = {c.model_id: (c.input_cost_per_mtok, c.output_cost_per_mtok)
                  for c in catalog.models}

        print(f"{'TASK':<22} {'SLIDER':>6}  {'MODEL':<26} {'BASIS':<8} {'Q':>5}  {'COST':>10}  {'MS':>6}")
        print("-" * 92)

        results = []
        for task in TASKS:
            r = await run_task(minima, task, prices)
            results.append(r)
            print(
                f"{r['label']:<22} {r['slider']:>6.1f}  {r['model']:<26} "
                f"{r['basis']:<8} {r['quality']:>5.2f}  ${r['cost_usd']:>9.6f}  {r['latency_ms']:>6}"
            )

        # Summary
        total_cost = sum(r["cost_usd"] for r in results)
        avg_quality = sum(r["quality"] for r in results) / len(results)
        memory_driven = sum(1 for r in results if r["basis"] == "memory")
        print("-" * 92)
        print(f"{'TOTAL / AVG':<22} {'':>6}  {'':>26} {'':>8} {avg_quality:>5.2f}  ${total_cost:>9.6f}")
        print(f"\nmemory-driven decisions: {memory_driven}/{len(results)}  "
              f"(run again to see this rise as Minima learns)")


if __name__ == "__main__":
    asyncio.run(main())
