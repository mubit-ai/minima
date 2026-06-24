"""Phase 2 — watch the learning loop: prior -> memory as feedback accumulates.

Runs the same task through recommend -> feedback in a loop on an isolated namespace and
prints decision_basis + evidence depth + top model each iteration, so you can see Minima
flip from capability priors ("prior") to empirical recall ("memory").

No LLM cost: Minima's recommend/feedback never call a model (escalation is disabled). Only
Mubit memory is touched, on an isolated lane so your default namespace stays clean.

    set -a; source .env; set +a
    uv run python tests/playground/watch_learning.py
    uv run python tests/playground/watch_learning.py --iterations 6 --namespace learn-demo
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any

from minima_client import AsyncMinimaClient

DEFAULT_URL = "http://localhost:8088"
TASK = {
    "task": "Summarize a 2-page incident report into 3 bullet points.",
    "task_type": "summarization",
    "difficulty": "medium",
    "expected_input_tokens": 1800,
    "expected_output_tokens": 120,
}


def row(iteration: int, rec: Any) -> dict[str, Any]:
    rm = rec.recommended_model
    return {
        "iter": iteration,
        "basis": str(rec.decision_basis),
        "conf": f"{rec.confidence:.2f}",
        "evidence": len(rm.evidence),
        "model": rm.model_id,
        "cost$": f"{rm.est_cost_usd:.5f}",
        "warnings": ",".join(rec.warnings) or "-",
    }


def print_table(rows: list[dict[str, Any]]) -> None:
    cols = ["iter", "basis", "conf", "evidence", "model", "cost$", "warnings"]
    widths = {c: max(len(c), max(len(str(r[c])) for r in rows)) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    print("-" * (sum(widths.values()) + 2 * (len(cols) - 1)))
    for r in rows:
        print("  ".join(str(r[c]).ljust(widths[c]) for c in cols))


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ap.add_argument("--iterations", type=int, default=4)
    ns_default = f"learn-{int(time.time())}"
    ap.add_argument("--namespace", default=ns_default, help="isolated lane (default: fresh)")
    ap.add_argument("--tradeoff", type=float, default=5.0)
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    print(f"\nwatch_learning  ->  {args.url}\nnamespace={args.namespace}  iters={args.iterations}")
    print(f"{'-' * 64}\n")

    rows: list[dict[str, Any]] = []
    async with AsyncMinimaClient(args.url, api_key=args.key, timeout=60.0) as minima:
        for i in range(1, args.iterations + 1):
            rec = await minima.recommend(
                TASK,
                cost_quality_tradeoff=args.tradeoff,
                namespace=args.namespace,
                allow_llm_escalation=False,
            )
            r = row(i, rec)
            rows.append(r)
            print(
                f"  iter {i}: basis={r['basis']:<6} evidence={r['evidence']}  "
                f"model={r['model']}  warnings={r['warnings']}"
            )
            await minima.feedback(
                rec.recommendation_id,
                rec.recommended_model.model_id,
                "success",
                quality_score=0.95,
                input_tokens=1760,
                output_tokens=110,
                actual_cost_usd=0.0021,
                latency_ms=420,
                verified_in_production=True,
                namespace=args.namespace,
            )

    print(f"\n{'-' * 64}\n")
    print_table(rows)
    prior = sum(1 for r in rows if r["basis"] == "prior")
    memory = sum(1 for r in rows if r["basis"] == "memory")
    print(
        f"\nbasis share: prior={prior}  memory={memory}  "
        f"(memory should grow once recall finds the feedback)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
