"""Smoke test — verify Mubit reachable, recommend/feedback round-trip works, recall returns evidence.

Run before a full warmup to confirm the stack is healthy end-to-end.

    uv run python examples/smoke_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from minima.schemas.common import Constraints
from minima_client import AsyncMinimaClient

MINIMA_URL = os.environ.get("MINIMA_URL", "https://api.minima.sh")
MUBIT_KEY  = os.environ.get("MUBIT_API_KEY")

CANDIDATES = [
    "gemini-2.5-flash",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "gemini-2.5-pro",
    "claude-opus-4-8",
]

PASS = "✓"
FAIL = "✗"


def check(label: str, condition: bool, detail: str = "") -> bool:
    icon = PASS if condition else FAIL
    print(f"  {icon}  {label}" + (f"  →  {detail}" if detail else ""))
    return condition


async def main() -> None:
    print(f"\nSmoke test → {MINIMA_URL}\n{'─'*56}")
    failures = 0

    async with AsyncMinimaClient(MINIMA_URL, api_key=MUBIT_KEY, timeout=60.0) as minima:

        # ── 1. Health ────────────────────────────────────────────
        print("\n[1] Health check")
        h = await minima.health()
        mubit = h.get("mubit", {})

        ok = check("Minima responds", h.get("status") in ("ok", "degraded"),
                   h.get("status", "?"))
        failures += not ok

        ok = check("Mubit reachable", mubit.get("reachable") is True,
                   f"reachable={mubit.get('reachable')}  status_code={mubit.get('status_code', '?')}")
        failures += not ok

        ok = check("Catalog loaded", h.get("catalog", {}).get("models", 0) > 0,
                   f"{h.get('catalog', {}).get('models', 0)} models")
        failures += not ok

        # ── 2. Recommend (cold, no seeding) ─────────────────────
        print("\n[2] Recommend — cold call (expect basis=prior)")
        rec = await minima.recommend(
            {"task": "Translate 'Hello world' to French.", "task_type": "translation"},
            cost_quality_tradeoff=2.0,
            constraints=Constraints(candidate_models=CANDIDATES),
        )
        model  = rec.recommended_model.model_id
        basis  = str(rec.decision_basis)
        rec_id = rec.recommendation_id

        ok = check("Returned a model", bool(model), model)
        failures += not ok
        ok = check("Model is in candidate set", model in CANDIDATES, model)
        failures += not ok
        check("Decision basis", True, basis)   # just report, not a failure

        # ── 3. Feedback ──────────────────────────────────────────
        print("\n[3] Feedback — report outcome so Mubit stores a record")
        fb = await minima.feedback(
            rec_id, model, "success",
            quality_score=1.0,
            input_tokens=20, output_tokens=10,
            actual_cost_usd=0.000012,
            latency_ms=300,
            verified_in_production=True,
        )
        ok = check("Feedback accepted", getattr(fb, "accepted", True) is not False,
                   str(fb))
        failures += not ok

        # ── 4. Second recommend — should now have recall evidence ─
        print("\n[4] Recommend — second call for similar task (expect evidence in response)")
        rec2 = await minima.recommend(
            {"task": "Translate 'Good morning' to French.", "task_type": "translation"},
            cost_quality_tradeoff=2.0,
            constraints=Constraints(candidate_models=CANDIDATES),
        )
        evidence = rec2.recommended_model.evidence
        basis2   = str(rec2.decision_basis)

        check("Decision basis", True, basis2)
        ok = check(
            "Recall returned evidence",
            len(evidence) > 0,
            f"{len(evidence)} evidence items" if evidence
            else "EMPTY — recall still not working (check MINIMA_RECALL_MODE=agent_routed on server)",
        )
        failures += not ok
        if evidence:
            e = evidence[0]
            check("Evidence has model + similarity",
                  bool(e.model_id) and e.score >= 0,
                  f"model={e.model_id}  sim={e.score:.3f}  obs_success={e.observed_success:.2f}")

        # ── 5. Strategies ────────────────────────────────────────
        print("\n[5] Strategies — Minima's learned lessons")
        strats = await minima.strategies()
        ok = check("Strategies endpoint responds", strats is not None)
        failures += not ok
        check("Strategy count", True, f"{strats.count} strategies in memory")

    # ── Result ───────────────────────────────────────────────────
    print(f"\n{'─'*56}")
    if failures == 0:
        print(f"{PASS}  All checks passed — stack is healthy. Run the full warmup.\n")
    else:
        print(f"{FAIL}  {failures} check(s) failed — fix before running the full warmup.\n")
    sys.exit(failures)


if __name__ == "__main__":
    asyncio.run(main())
