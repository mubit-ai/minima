"""Example 9 — A/B the savings claim: routed vs. pinned premium, on realized cost.

Run the SAME task set twice and price both arms off the same catalog:

    arm A (routed)   Minima picks from the full candidate pool
    arm B (premium)  the pool is pinned to one premium model — what you'd do without routing

The comparison is only honest if both arms are *real* recommendations. The pin is applied
as `Constraints(candidate_models=[premium])` BEFORE the request, so arm B is a genuine
decision over a one-model pool — not a post-hoc override of arm A's pick. Re-ranking
Minima's answer client-side would break propensity logging and quietly poison the very
counterfactual reports (`/v1/policy-value`) that judge this trade.

Both arms report feedback with realized usage, so the run also *teaches* memory instead of
only measuring it. Cost is quoted per-arm alongside mean quality — a cost win that cost you
quality is not a win, and the footer makes that impossible to hide.

    uv run python examples/09_ab_savings.py
    ANTHROPIC_API_KEY=sk-ant-... uv run python examples/09_ab_savings.py   # run for real

Set MINIMA_URL (default http://localhost:8080) and, in multi-tenant mode, MINIMA_KEY.
"""

from __future__ import annotations

import importlib.util
import os
import time
from dataclasses import dataclass

from minima_client import Constraints, MinimaClient, MinimaError, Usage

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
KEY = os.environ.get("MINIMA_KEY")  # only needed in multi-tenant mode
# A key in the environment does not mean the SDK is installed — check both, or a stray
# ANTHROPIC_API_KEY turns a simulated run into an ImportError halfway through the table.
CAN_RUN_REAL = bool(os.environ.get("ANTHROPIC_API_KEY")) and (
    importlib.util.find_spec("anthropic") is not None
)
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") if CAN_RUN_REAL else None

# The model you'd have hardcoded if you weren't routing. Arm B's whole pool.
PREMIUM_MODEL = os.environ.get("MINIMA_PREMIUM_MODEL", "claude-sonnet-4-6")

TASKS: list[tuple[str, str, float]] = [
    ("Extract the order id and total from: 'Order #A-9931 totalling $48.20 shipped.'",
     "extraction", 2.0),
    ("Classify this ticket as billing, bug, or feature: 'the export button does nothing'.",
     "classification", 2.0),
    ("Summarize in one sentence: a customer wants a refund after a duplicate charge.",
     "summarization", 3.0),
    ("Write a Python function that merges two sorted lists without using sorted().",
     "code", 5.0),
    ("Design a retry policy with jitter for a flaky payment webhook; justify the math.",
     "reasoning", 7.0),
]


@dataclass
class Outcome:
    model_id: str
    cost_usd: float
    quality: float


def price(catalog, model_id: str) -> tuple[float, float]:
    """(input $/Mtok, output $/Mtok) for a model from the catalog; (0,0) if unknown."""
    for card in catalog.models:
        if card.model_id == model_id:
            return card.input_cost_per_mtok, card.output_cost_per_mtok
    return 0.0, 0.0


def run_anthropic(model_id: str, prompt: str) -> tuple[str, int, int, int]:
    """(text, input_tokens, output_tokens, latency_ms) from a real Anthropic call."""
    from anthropic import Anthropic

    started = time.monotonic()
    client = Anthropic(api_key=ANTHROPIC_KEY)
    with client.messages.stream(
        model=model_id, max_tokens=1024, messages=[{"role": "user", "content": prompt}]
    ) as stream:
        msg = stream.get_final_message()
    text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
    return text, msg.usage.input_tokens, msg.usage.output_tokens, int(
        (time.monotonic() - started) * 1000
    )


def simulate(model_id: str, prompt: str) -> tuple[str, int, int, int]:
    """Deterministic stand-in: no keys, no spend, same shape as a real run."""
    return f"[simulated output from {model_id}]", max(1, len(prompt) // 4), 180, 900


def grade(text: str) -> float:
    """Your real quality signal goes here (tests pass, eval rubric, human rating, ...)."""
    return 0.95 if text and "[simulated" not in text else 0.9


def arm(minima: MinimaClient, catalog, prompt: str, task_type: str, slider: float,
        constraints: Constraints | None) -> Outcome:
    rec = minima.recommend(
        {"task": prompt, "task_type": task_type},
        cost_quality_tradeoff=slider,
        constraints=constraints,
    )
    model_id = rec.recommended_model.model_id

    real = bool(ANTHROPIC_KEY) and rec.recommended_model.provider.lower() == "anthropic"
    text, in_tok, out_tok, latency_ms = (
        run_anthropic(model_id, prompt) if real else simulate(model_id, prompt)
    )

    # Price the REALIZED tokens off the catalog. Never echo rec.recommended_model
    # .est_cost_usd back as the actual cost — that is what lets the cost basis climb
    # estimate -> observed -> rescaled, and echoing the estimate freezes it at tier one.
    in_price, out_price = price(catalog, model_id)
    cost = in_tok / 1e6 * in_price + out_tok / 1e6 * out_price
    quality = grade(text)

    try:
        minima.feedback(
            rec.recommendation_id, model_id,
            "success" if quality >= 0.8 else "partial" if quality >= 0.4 else "failure",
            Usage(input_tokens=in_tok, output_tokens=out_tok,
                  cost_usd=round(cost, 8), latency_ms=latency_ms),
            quality_score=quality,
        )
    except MinimaError as exc:
        print(f"  (feedback failed for {model_id}, ignoring: {exc})")

    return Outcome(model_id=model_id, cost_usd=cost, quality=quality)


def main() -> None:
    with MinimaClient(URL, api_key=KEY) as minima:
        try:
            catalog = minima.models()
        except MinimaError as exc:
            print(f"could not reach Minima at {URL}: {exc}")
            print("start it with `make run`, or set MINIMA_URL to a live deployment.")
            return

        if not any(c.model_id == PREMIUM_MODEL for c in catalog.models):
            available = ", ".join(sorted(c.model_id for c in catalog.models)[:8])
            print(f"premium model {PREMIUM_MODEL!r} is not in this catalog.")
            print(f"set MINIMA_PREMIUM_MODEL to one of: {available} …")
            return

        if not CAN_RUN_REAL:
            print("simulating every model run (routing + feedback are real). To run for real:")
            print("  ANTHROPIC_API_KEY=sk-ant-… uv pip install anthropic\n")

        pinned = Constraints(candidate_models=[PREMIUM_MODEL])
        rows: list[tuple[str, Outcome, Outcome]] = []
        for prompt, task_type, slider in TASKS:
            print(f"• {task_type}")
            routed = arm(minima, catalog, prompt, task_type, slider, None)
            premium = arm(minima, catalog, prompt, task_type, slider, pinned)
            rows.append((task_type, routed, premium))

        print(f"\n{'task':<18}{'routed':<26}{'premium':<26}")
        for task_type, routed, premium in rows:
            print(f"{task_type:<18}"
                  f"{routed.model_id + f' ${routed.cost_usd:.5f}':<26}"
                  f"{premium.model_id + f' ${premium.cost_usd:.5f}':<26}")

        routed_cost = sum(r.cost_usd for _, r, _ in rows)
        premium_cost = sum(p.cost_usd for _, _, p in rows)
        routed_q = sum(r.quality for _, r, _ in rows) / len(rows)
        premium_q = sum(p.quality for _, _, p in rows) / len(rows)
        saved_pct = (1 - routed_cost / premium_cost) * 100 if premium_cost else 0.0

        print(f"\n{'total':<18}${routed_cost:<25.5f}${premium_cost:.5f}")
        print(f"{'mean quality':<18}{routed_q:<26.3f}{premium_q:.3f}")
        print(f"\nsaved ${premium_cost - routed_cost:.5f} ({saved_pct:.1f}%) "
              f"at {routed_q - premium_q:+.3f} quality")
        if routed_q < premium_q - 0.05:
            print("⚠ quality dropped more than the cost win justifies — raise the slider.")
        print("\nAggregate view across every decision, not just this run: "
              "uv run python examples/07_observability.py")


if __name__ == "__main__":
    main()
