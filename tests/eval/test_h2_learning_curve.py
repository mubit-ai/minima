"""H2 end-to-end: does Minima's routing improve as (simulated) feedback accumulates?

Runs the fixed-probe learning curve of ``learning_curve.py`` (CRITERIA.md §10) on the
LLMRouterBench frontier suite. The test asserts RUN VALIDITY (guards, both arms, cold+warm
present); the L1–L4 verdicts are printed — a negative H2 is a reportable result, not a bug.

    # shakeout (Phase 2a — fieldnote/benchmark-plan.md):
    MINIMA_H2_PROBE_N=30 MINIMA_H2_TRAIN_N=200 MINIMA_H2_CHECKPOINTS=0,100,200 \
    MINIMA_H2_ORDERINGS=42 MUBIT_API_KEY=... uv run --extra seed --extra dev \
      pytest -m eval -k h2_learning -s -q
    # full (Phase 2b): defaults + MINIMA_H2_SLIDER=<Phase-1 selected slider>
"""

from __future__ import annotations

import json
import os

import pytest

from minima.config import Settings
from minima.seeding import llmrouterbench as lrb
from tests.eval import learning_curve as lc
from tests.eval import llmrouterbench_config as cfg

pytestmark = [
    pytest.mark.eval,
    pytest.mark.skipif(not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"),
]


async def test_h2_learning_curve():
    settings = Settings(
        minima_memory_recall_timeout_ms=int(os.getenv("MINIMA_EVAL_RECALL_TIMEOUT_MS", "30000")),
        minima_memory_recall_limit=int(os.getenv("MINIMA_EVAL_RECALL_LIMIT", "48")),
        mubit_timeout_ms=120_000,
    )
    candidates = list(cfg.CANDIDATES)
    env_cands = os.getenv("MINIMA_EVAL_CANDIDATES")
    if env_cands:
        requested = [c.strip() for c in env_cands.split(",") if c.strip()]
        unknown = sorted(set(requested) - set(cfg.CANDIDATES))
        assert not unknown, f"candidates not in llmrouterbench_config.CANDIDATES: {unknown}"
        assert cfg.PREMIUM in requested, f"premium '{cfg.PREMIUM}' must be a candidate"
        candidates = requested

    checkpoints = [int(x) for x in os.getenv("MINIMA_H2_CHECKPOINTS", "0,100,200,400,800").split(",")]
    ordering_seeds = [int(x) for x in os.getenv("MINIMA_H2_ORDERINGS", "42,43,44").split(",")]

    res = await lc.run_learning_curve(
        settings=settings,
        candidates=candidates,
        premium=cfg.PREMIUM,
        train_n=int(os.getenv("MINIMA_H2_TRAIN_N", "800")),
        probe_n=int(os.getenv("MINIMA_H2_PROBE_N", "150")),
        checkpoints=checkpoints,
        ordering_seeds=ordering_seeds,
        slider=float(os.getenv("MINIMA_H2_SLIDER", "1.0")),
        seed=int(os.getenv("MINIMA_EVAL_SEED", "42")),
        load_df=lambda: lrb.load_llmrouterbench_df(tuple(candidates), cfg.EVAL_DATASETS),
        task_type_for=cfg.task_type_for,
        market_prices=dict(cfg.MARKET_PRICES),
        provider_for=cfg.provider_for,
    )

    print("\n" + lc.report(res))
    out = os.getenv("MINIMA_H2_OUT")
    if out:
        with open(out, "w") as f:
            json.dump({
                "config": {"candidates": res.candidates, "premium": res.premium,
                           "slider": res.slider, "probe_n": res.probe_n,
                           "checkpoints": res.checkpoints, "orderings": res.ordering_seeds},
                "points": [{"arm": p.arm, "ordering": p.ordering_seed, "memory": p.memory_size,
                            "accuracy": p.accuracy, "cost": p.cost,
                            "savings": p.savings_vs_premium, "retention": p.retention,
                            "picks": p.pick_counts} for p in res.points],
                "L1": {"lift_acc": res.lift_acc, "ci": res.lift_acc_ci,
                       "lift_savings": res.lift_savings},
                "L2": {"trend_rho": res.trend_rho},
                "L3": {"shuffled_lift_acc": res.shuffled_lift_acc},
                "L4": {"convergence_k": res.convergence_k},
                "guards": res.guards,
            }, f, indent=2)
        print(f"wrote {out}")

    # Validity asserts only — the scientific verdict is reported above.
    assert res.guards.get("v6_probe_disjoint"), "V6 violated: probe leaked into train"
    assert res.guards.get("v7_barrier"), "V7 violated: ingest barrier failed"
    arms = {p.arm for p in res.points}
    assert arms == {lc.REAL, lc.SHUFFLED}, f"missing arm(s): {arms}"
    sizes = {p.memory_size for p in res.points}
    assert 0 in sizes and res.checkpoints[-1] in sizes, "cold or warm checkpoint missing"
