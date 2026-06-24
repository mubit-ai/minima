"""Phase 3 — drive the cost-basis tiers: estimate -> observed -> rescaled.

The biggest accuracy lever is feeding back REALIZED tokens/cost so a model's cost estimate
climbs tiers (score.py). On an isolated namespace constrained to one candidate model, this
script snapshots `est_cost_breakdown` + `rationale` at three points:

  0 feedbacks      -> estimate tier   breakdown keys: {input, output}
  N cost-only fbs  -> observed tier   breakdown keys: {observed_avg}
  N token+cost fbs -> rescaled tier   breakdown keys: {rescaled, obs_output_tokens}

Rescaled re-prices a model for THIS request size using observed output-token behavior — the
size-exact cost that exposes "cheap list price, heavy thinking" models. Needs >= min_n
(default 3, MINIMA_OBSERVED_COST_MIN_N) observations.

No LLM cost: recommend/feedback only touch Mubit memory, on an isolated lane.

    set -a; source .env; set +a
    uv run python tests/playground/cost_basis_tiers.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any

from minima_client import AsyncMinimaClient

from minima.schemas.common import Constraints

DEFAULT_URL = "http://localhost:8088"
TASK = {
    "task": "Draft a 3-paragraph release notes summary from the changelog.",
    "task_type": "summarization",
    "difficulty": "medium",
    "expected_input_tokens": 1500,
    "expected_output_tokens": 250,
}
DEFAULT_MODEL = "gemini-2.5-flash"


def tier_of(breakdown: dict[str, float]) -> str:
    if "rescaled" in breakdown:
        return "rescaled"
    if "observed_avg" in breakdown:
        return "observed"
    return "estimate"


def snapshot(label: str, rec: Any) -> dict[str, Any]:
    rm = rec.recommended_model
    b = rm.est_cost_breakdown
    tier = tier_of(b)
    print(
        f"  [{label}]  tier={tier:<9}  cost=${rm.est_cost_usd:.6f}  "
        f"breakdown={ {k: round(v, 5) for k, v in b.items()} }"
    )
    print(f"             rationale: {rm.rationale}")
    return {"label": label, "tier": tier, "cost": rm.est_cost_usd, "breakdown": dict(b)}


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ns_default = f"tiers-{int(time.time())}"
    ap.add_argument("--namespace", default=ns_default, help="isolated lane (default: fresh)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="single candidate to drive")
    ap.add_argument("--min-n", type=int, default=3, help="observations per tier (server default 3)")
    ap.add_argument("--tradeoff", type=float, default=5.0)
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    constraints = Constraints(candidate_models=[args.model])
    print(f"\ncost_basis_tiers  ->  {args.url}\nnamespace={args.namespace}  model={args.model}")
    print(f"{'-' * 72}\n")

    results: list[dict[str, Any]] = []
    async with AsyncMinimaClient(args.url, api_key=args.key, timeout=60.0) as minima:
        rec = await minima.recommend(
            TASK,
            cost_quality_tradeoff=args.tradeoff,
            constraints=constraints,
            namespace=args.namespace,
            allow_llm_escalation=False,
        )
        results.append(snapshot("0 fb             ", rec))

        for _ in range(args.min_n):
            r = await minima.recommend(
                TASK,
                cost_quality_tradeoff=args.tradeoff,
                constraints=constraints,
                namespace=args.namespace,
                allow_llm_escalation=False,
            )
            await minima.feedback(
                r.recommendation_id,
                r.recommended_model.model_id,
                "success",
                quality_score=0.9,
                actual_cost_usd=0.0015,
                namespace=args.namespace,
            )
        rec = await minima.recommend(
            TASK,
            cost_quality_tradeoff=args.tradeoff,
            constraints=constraints,
            namespace=args.namespace,
            allow_llm_escalation=False,
        )
        results.append(snapshot(f"{args.min_n} cost-only fb", rec))

        for i in range(args.min_n):
            r = await minima.recommend(
                TASK,
                cost_quality_tradeoff=args.tradeoff,
                constraints=constraints,
                namespace=args.namespace,
                allow_llm_escalation=False,
            )
            await minima.feedback(
                r.recommendation_id,
                r.recommended_model.model_id,
                "success",
                quality_score=0.9,
                input_tokens=1480,
                output_tokens=240 + i * 10,
                actual_cost_usd=0.0015,
                namespace=args.namespace,
            )
        rec = await minima.recommend(
            TASK,
            cost_quality_tradeoff=args.tradeoff,
            constraints=constraints,
            namespace=args.namespace,
            allow_llm_escalation=False,
        )
        results.append(snapshot(f"{args.min_n * 2} token fb   ", rec))

    print(f"\n{'-' * 72}")
    tiers = [r["tier"] for r in results]
    seen = []
    for t in tiers:
        if t not in seen:
            seen.append(t)
    print(f"tier progression observed: {' -> '.join(tiers)}")
    print(f"distinct tiers reached:    {' -> '.join(seen)}")
    print(
        "\nA clean run shows: estimate -> observed -> rescaled.\n"
        "If 'rescaled' is missing, raise --min-n or confirm feedback carried output_tokens.\n"
    )
    return 0 if seen == ["estimate", "observed", "rescaled"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
