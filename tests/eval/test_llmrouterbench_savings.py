"""End-to-end H1 on LLMRouterBench: does Minima's router cut cost at preserved accuracy?

Same machinery as ``test_routerbench_savings.py`` (validation-selected operating point,
bootstrap CIs, leakage diagnostic, engine crosscheck) but pointed at the modern 2026
LLMRouterBench frontier suite via the pluggable backend added in
``docs/PLAN/LLMRouterBench-H1-setup.md`` (Phases 3-4). Candidates/prices/datasets come from
``llmrouterbench_config``.

    MUBIT_API_KEY=... uv run --extra seed pytest -m eval -k llmrouterbench -s -q
    # smoke first:  MINIMA_EVAL_TRAIN_N=150 MINIMA_EVAL_TEST_N=40 MINIMA_EVAL_VAL_N=30 ...
"""

from __future__ import annotations

import os

import pytest

from minima.config import Settings
from minima.seeding import llmrouterbench as lrb
from tests.eval import harness
from tests.eval import llmrouterbench_config as cfg
from tests.eval.test_routerbench_savings import RETENTION_FLOOR, SAVINGS_FLOOR, _report, _sliders

pytestmark = [
    pytest.mark.eval,
    pytest.mark.skipif(not os.getenv("MUBIT_API_KEY"), reason="needs MUBIT_API_KEY + running Mubit"),
]


async def test_llmrouterbench_cost_reduction():
    settings = Settings(
        minima_memory_recall_timeout_ms=int(os.getenv("MINIMA_EVAL_RECALL_TIMEOUT_MS", "30000")),
        minima_memory_recall_limit=int(os.getenv("MINIMA_EVAL_RECALL_LIMIT", "40")),
        mubit_timeout_ms=120_000,  # long frontier prompts (swe-bench, arena) embed slowly
    )

    def load_df():
        return lrb.load_llmrouterbench_df(cfg.CANDIDATES, cfg.EVAL_DATASETS)

    try:
        result = await harness.evaluate(
            settings=settings,
            candidates=list(cfg.CANDIDATES),
            premium=cfg.PREMIUM,
            train_n=int(os.getenv("MINIMA_EVAL_TRAIN_N", "800")),
            val_n=int(os.getenv("MINIMA_EVAL_VAL_N", "60")),
            test_n=int(os.getenv("MINIMA_EVAL_TEST_N", "120")),
            sliders=_sliders(),
            retention_floor=RETENTION_FLOOR,
            seed=int(os.getenv("MINIMA_EVAL_SEED", "42")),
            hard_frac=0.0,  # the 14 frontier datasets are uniformly hard; no easy/hard split
            load_df=load_df,
            task_type_for=cfg.task_type_for,
            market_prices=dict(cfg.MARKET_PRICES),
            provider_for=cfg.provider_for,
            source_dataset="llmrouterbench",
        )
    except RuntimeError as exc:
        if "seed' extra" in str(exc) or "huggingface" in str(exc).lower():
            pytest.skip(f"LLMRouterBench unavailable: {exc}")
        raise

    _report(result)

    prem = result.baselines["always_premium"]
    cheapest = result.baselines["always_cheapest"]
    oracle = result.baselines["oracle"]
    rand = result.baselines["random_expectation"]
    h = result.headline

    # Explicit criteria verdict (printed even if an assertion below fails) — see CRITERIA.md §5.
    print("\n" + "=" * 84)
    print("CRITERIA VERDICT (LLMRouterBench frontier suite)")
    c1 = h.savings_vs_premium >= SAVINGS_FLOOR
    c2 = h.accuracy >= cheapest["accuracy"] + 0.05
    c3 = h.accuracy >= rand["accuracy"] and h.cost <= rand["cost"]
    print(f"  C1 savings   : {h.savings_vs_premium:.1%}  (>= {SAVINGS_FLOOR:.0%}?)            -> {'PASS' if c1 else 'FAIL'}")
    print(f"  C2 not-naive : acc {h.accuracy:.3f} vs cheapest {cheapest['accuracy']:.3f} (+0.05?) -> {'PASS' if c2 else 'FAIL'}")
    print(f"  C3 dominates : acc>=rand {h.accuracy:.3f}>={rand['accuracy']:.3f} AND cost<=rand "
          f"${h.cost:.4f}<=${rand['cost']:.4f} -> {'PASS' if c3 else 'FAIL'}")
    print(f"  C4 retention : {h.accuracy_retention:.1%} (95% CI {result.headline_retention_ci[0]:.1%}"
          f"-{result.headline_retention_ci[1]:.1%}) [reported]")
    print("=" * 84)

    # Sanity invariants — these must hold regardless of N or workload (else the run is broken).
    assert result.crosscheck_match_rate >= 0.8, (
        f"factored scoring diverged from Recommender.recommend(): {result.crosscheck_match_rate:.0%}"
    )
    assert oracle["accuracy"] >= prem["accuracy"] - 1e-9
    assert cheapest["cost"] <= prem["cost"]
    assert result.leaky_fraction <= 0.5, f"too many near-twin recalls (leakage): {result.leaky_fraction:.0%}"

    # The H1 claims (CRITERIA.md C1-C3).
    assert c1, f"savings {h.savings_vs_premium:.1%} < {SAVINGS_FLOOR:.0%}"
    assert c2, f"router acc {h.accuracy:.3f} not clearly above always-cheapest {cheapest['accuracy']:.3f}"
    assert c3, (
        f"router (acc={h.accuracy:.3f}, ${h.cost:.4f}) does not dominate random "
        f"(acc={rand['accuracy']:.3f}, ${rand['cost']:.4f})"
    )
