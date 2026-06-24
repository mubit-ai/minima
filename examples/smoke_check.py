"""Phase 0 smoke check — health + catalog + one cold recommend, one line per check.

Lighter than smoke_test.py (which also does feedback + recall verification): this just
confirms the local stack is wired up before deeper testing. Defaults to the local server
started in Phase 0 of docs/PLAN/hands-on-testing.md.

    uv run python examples/smoke_check.py
    MINIMA_URL=http://localhost:8088 uv run python examples/smoke_check.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from minima_client import AsyncMinimaClient

MINIMA_URL = os.environ.get("MINIMA_URL", "http://localhost:8088")
MINIMA_KEY = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")


def check(label: str, condition: bool, detail: str = "") -> bool:
    result = "PASS" if condition else "FAIL"
    print(f"  [{result}]  {label}" + (f"  ->  {detail}" if detail else ""))
    return condition


async def main() -> None:
    print(f"\nPhase 0 smoke check  ->  {MINIMA_URL}\n{'-' * 60}")
    failures = 0

    async with AsyncMinimaClient(MINIMA_URL, api_key=MINIMA_KEY, timeout=30.0) as minima:
        # 1. Health
        print("\n[1] /v1/health")
        try:
            h = await minima.health()
            mubit = h.get("mubit", {})
            cat = h.get("catalog", {})
            failures += not check(
                "Minima responds", h.get("status") in ("ok", "degraded"), h.get("status", "?")
            )
            failures += not check(
                "Mubit reachable",
                mubit.get("reachable") is True,
                f"reachable={mubit.get('reachable')} http={mubit.get('status_code', '?')}",
            )
            failures += not check(
                "Catalog loaded", cat.get("models", 0) > 0, f"{cat.get('models', 0)} models"
            )
        except Exception as exc:  # noqa: BLE001
            failures += not check("Health endpoint", False, f"{type(exc).__name__}: {exc}")

        # 2. Models (catalog)
        print("\n[2] /v1/models")
        try:
            models = await minima.models()
            n = len(models.models)
            failures += not check("Catalog returned", n > 0, f"{n} models")
            if models.models:
                m = models.models[0]
                detail = (
                    f"{m.model_id}  in=${m.input_cost_per_mtok}/Mtok"
                    f"  cache={m.supports_prompt_caching}"
                )
                check(
                    "Sample model card",
                    bool(m.model_id) and m.input_cost_per_mtok >= 0,
                    detail,
                )
            failures += not check(
                "Catalog not stale", models.stale is False, f"stale={models.stale}"
            )
        except Exception as exc:  # noqa: BLE001
            failures += not check("Models endpoint", False, f"{type(exc).__name__}: {exc}")

        # 3. One cold recommend
        print("\n[3] /v1/recommend  (basis = prior if cold, memory if warm)")
        try:
            rec = await minima.recommend(
                {"task": "Say hello in 3 words.", "task_type": "other", "difficulty": "trivial"},
                cost_quality_tradeoff=3.0,
                allow_llm_escalation=False,
            )
            rm = rec.recommended_model
            failures += not check("Returned a model", bool(rm.model_id), rm.model_id)
            check(
                "Decision basis",
                True,
                f"basis={rec.decision_basis}"
                + (" (cold)" if str(rec.decision_basis) == "prior" else " (warm - recall works)"),
            )
            check(
                "Warnings",
                True,
                f"{rec.warnings or '[]'}",
            )
            check(
                "Est cost",
                rm.est_cost_usd >= 0,
                f"est=${rm.est_cost_usd:.6f}  tau={rec.threshold_used:.2f}",
            )
        except Exception as exc:  # noqa: BLE001
            failures += not check("Recommend endpoint", False, f"{type(exc).__name__}: {exc}")

    print(f"\n{'-' * 60}")
    if failures == 0:
        print("All checks passed. Stack is healthy. Move on to Phase 1.\n")
    else:
        print(f"{failures} check(s) failed. Fix before proceeding.\n")
    sys.exit(failures)


if __name__ == "__main__":
    asyncio.run(main())
