"""Phase 5 — before/after reasoner comparison: deterministic vs LLM escalation.

Runs a set of cold, ambiguous prompts twice on fresh isolated namespaces:

  pass A  allow_llm_escalation=False  (deterministic scoring only)
  pass B  allow_llm_escalation=True   (cheap-LLM reasoner consulted on thin evidence)

and reports pick-diff + latency cost, plus whether the reasoner was actually consulted.

NOTE on cost: pass A never calls an LLM. Pass B only calls the reasoner when the server has
one configured (MINIMA_REASONER_PROVIDER != none). If none is configured, pass B short-
circuits to `reasoner_disabled` and falls back to deterministic — so this script is safe to
run with NO reasoner: it will simply report pick-diff=0 and "reasoner: disabled". Configure
a reasoner extra (see docs/PLAN/hands-on-testing.md Phase 5) and re-run for a real diff.

    set -a; source .env; set +a
    uv run python tests/playground/reasoner_compare.py
    uv run python tests/playground/reasoner_compare.py --limit 6
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

# Intentionally vague prompts to exercise heuristic classification + thin-evidence escalation.
PROMPTS: list[str] = [
    "Help me decide between Postgres and DynamoDB for a multi-tenant SaaS.",
    "What's the best way to onboard a new user to our app?",
    "Fix this bug.",
    "Write something nice for the company holiday card.",
    "Should we use a monolith or microservices for a team of five?",
    "Summarize.",
    "Translate this.",
    "Analyze the data and tell me what stands out.",
]


def _reasoner_state(warnings: list[str], basis: Any) -> str:
    if any("reasoner_consulted" in w for w in warnings) or str(basis) == "llm":
        return "consulted"
    if any("reasoner_failed" in w for w in warnings):
        return "failed"
    if any("reasoner_disabled" in w for w in warnings):
        return "disabled"
    return "-"


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ap.add_argument("--limit", type=int, default=len(PROMPTS), help="number of prompts to run")
    ap.add_argument("--tradeoff", type=float, default=5.0)
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    prompts = PROMPTS[: args.limit]
    stamp = int(time.time())
    ns_a = f"rcmp-a-{stamp}"
    ns_b = f"rcmp-b-{stamp}"

    print(f"\nreasoner_compare  ->  {args.url}\npassA ns={ns_a} (escalation=off)")
    print(f"passB ns={ns_b} (escalation=on)\n{'-' * 76}\n")

    async with AsyncMinimaClient(args.url, api_key=args.key, timeout=60.0) as minima:
        h = await minima.health()
        reasoner_cfg = h.get("reasoner", {}).get("configured", False)
        provider = h.get("reasoner", {}).get("provider", "?")
        print(f"server reasoner: configured={reasoner_cfg}  provider={provider}\n")

        rows: list[dict[str, Any]] = []
        for i, p in enumerate(prompts, 1):
            task = {"task": p}
            a = await minima.recommend(
                task,
                cost_quality_tradeoff=args.tradeoff,
                namespace=ns_a,
                allow_llm_escalation=False,
            )
            b = await minima.recommend(
                task,
                cost_quality_tradeoff=args.tradeoff,
                namespace=ns_b,
                allow_llm_escalation=True,
            )
            am, bm = a.recommended_model.model_id, b.recommended_model.model_id
            diff = "DIFF" if am != bm else "same"
            ra = _reasoner_state(a.warnings, a.decision_basis)
            rb = _reasoner_state(b.warnings, b.decision_basis)
            rows.append(
                {
                    "i": i,
                    "prompt": p[:42],
                    "a_model": am,
                    "b_model": bm,
                    "diff": diff,
                    "a_basis": str(a.decision_basis),
                    "b_basis": str(b.decision_basis),
                    "a_lat": a.latency_ms,
                    "b_lat": b.latency_ms,
                    "r_a": ra,
                    "r_b": rb,
                }
            )
            print(f"  #{i} {p[:42]:<42}  A={am:<22} B={bm:<22} {diff}  reasoner[B]={rb}")

    print(f"\n{'-' * 76}")
    diffs = sum(1 for r in rows if r["diff"] == "DIFF")
    consulted = sum(1 for r in rows if r["r_b"] == "consulted")
    avg_a = sum(r["a_lat"] for r in rows) / max(1, len(rows))
    avg_b = sum(r["b_lat"] for r in rows) / max(1, len(rows))
    print(f"pick-diff:      {diffs}/{len(rows)} prompts picked a different model with the reasoner")
    print(
        f"reasoner state: server configured={reasoner_cfg}; "
        f"consulted on {consulted}/{len(rows)} pass-B calls"
    )
    print(
        f"latency (ms):   passA avg={avg_a:.0f}  passB avg={avg_b:.0f}  delta={avg_b - avg_a:+.0f}"
    )
    if not reasoner_cfg:
        print(
            "\nreasoner NOT configured — pass B used the deterministic fallback"
            " (reasoner_disabled),\nso pick-diff is 0 by construction. Install a reasoner"
            " extra, set MINIMA_REASONER_PROVIDER,\nand re-run to measure real escalation"
            " impact + latency cost.\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
