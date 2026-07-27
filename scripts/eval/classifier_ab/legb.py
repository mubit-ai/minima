"""Leg B — downstream routing impact on RouterBench (PREREG §7).

Free: RouterBench ships per-(prompt, model) correctness AND realized USD, so cost/quality
are read off the benchmark; no model is ever run. Each arm gets its own Mubit lane, seeded
with that arm's own cluster keys — memory seeded under A1's keys is invisible to A3a, so
sharing a lane would silently starve every arm but the first.

HOME-FIELD/CONTAMINATED by construction: RouterBench is in the head's training corpus and
its eval_name->task_type map is the same function that labelled those training rows. That
flatters the head, so a null result here is conservative.

    uv run python scripts/eval/classifier_ab/legb.py --out <legb.json> [--config B1|B2]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

ARTIFACT = "models/classifier/potion-base-32M-c18e819c6c6d"


def build_classifiers():
    from arms import build_arms

    from minima.schemas.common import TaskType

    arms = build_arms(Path(ARTIFACT))

    def make(key):
        arm = arms[key]
        return lambda prompt: TaskType(arm.predict(prompt).task_type)

    # A5 = classify=None -> the harness's dataset-name oracle (its existing behavior).
    return {"A1": make("A1"), "A2": make("A2"), "A3a": make("A3a"), "A5": None}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--config", default="B1", choices=["B1", "B2"])
    ap.add_argument("--train-n", type=int, default=300)
    ap.add_argument("--val-n", type=int, default=40)
    ap.add_argument("--test-n", type=int, default=100)
    ap.add_argument("--arms", default="A1,A2,A3a,A5")
    args = ap.parse_args()

    from minima.config import Settings
    from tests.eval import harness

    settings = Settings()
    classifiers = build_classifiers()

    # B1: flat priors (V4 holds) -> the cluster-key/recall channel only.
    # B2: train-derived per-task-type priors -> the capability-prior channel is live too,
    #     at the cost of relaxing V4. Both reported; neither is the "real" one alone.
    use_train_priors = args.config == "B2"

    results = {}
    for key in args.arms.split(","):
        print(f"\n{'=' * 70}\n{args.config} arm {key}", flush=True)
        t0 = time.time()
        try:
            r = await harness.evaluate(
                settings=settings,
                train_n=args.train_n,
                val_n=args.val_n,
                test_n=args.test_n,
                use_train_priors=use_train_priors,
                classify=classifiers[key],
            )
        except Exception as exc:  # a dead lane must not take the other arms down
            print(f"  FAILED: {type(exc).__name__}: {exc}", flush=True)
            results[key] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        prem = r.baselines["always_premium"]
        results[key] = {
            "elapsed_s": time.time() - t0,
            "candidates": r.candidates,
            "premium": r.premium,
            "train_n": r.train_n, "val_n": r.val_n, "test_n": r.test_n,
            "seeded": r.seeded,
            "avg_recall_evidence": r.avg_recall_evidence,
            "crosscheck_match_rate": r.crosscheck_match_rate,
            "leaky_fraction": r.leaky_fraction,
            "headline_cost": r.headline.cost,
            "headline_accuracy": r.headline.accuracy,
            "headline_savings_vs_premium": r.headline.savings_vs_premium,
            "headline_retention": r.headline.accuracy_retention,
            "selected_slider": r.selected_slider,
            "picks": dict(r.headline.picks) if hasattr(r.headline, "picks") else None,
            "baselines": {
                k: {"accuracy": v["accuracy"], "cost": v["cost"]}
                for k, v in r.baselines.items()
                if not k.startswith("_")
            },
            "premium_accuracy": prem["accuracy"],
            "premium_cost": prem["cost"],
            "per_task_type": r.per_task_type,
        }
        print(f"  cost=${r.headline.cost:.4f} acc={r.headline.accuracy:.3f} "
              f"savings={r.headline.savings_vs_premium:.1%} "
              f"retention={r.headline.accuracy_retention:.1%} "
              f"evidence/prompt={r.avg_recall_evidence:.1f} "
              f"crosscheck={r.crosscheck_match_rate:.0%}", flush=True)

    args.out.write_text(json.dumps({"config": args.config, "arms": results}, indent=1))
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    if not os.environ.get("MUBIT_API_KEY"):
        raise SystemExit("MUBIT_API_KEY required (source the repo .env)")
    asyncio.run(main())
