"""Quantify the Phase 0/1 routing improvements on synthetic data, using the REAL code paths.

Run: ``uv run python examples/metrics_demo.py``

Two demonstrations:
  1. Calibration (P0.1): fit the isotonic calibrator on an overconfident model's history and
     show Expected Calibration Error (ECE) drop after the remap is applied.
  2. Routing-collapse margin guard (P1.1): at a high quality bar, show the guard cut the share
     of decisions defaulting to the priciest model (top_model_share) and the mean cost, while
     keeping realized success high — the cost/quality trade the guard is meant to recover.

Deterministic (seeded). No network, no Mubit — pure recommender internals.
"""

from __future__ import annotations

import random

from minima.metrics.calibration import _ece, fit_calibrators
from minima.recommender.decisionlog import CandidateSnapshot, DecisionRecord
from minima.recommender.engine import _optimize
from minima.recommender.types import CandidateScore
from minima.schemas.common import DecisionBasis
from minima.schemas.models_catalog import ModelCard


def _decision(rid: str, raw: float, outcome: str) -> DecisionRecord:
    rec = DecisionRecord(
        recommendation_id=rid,
        org_id="d",
        lane="l",
        cluster="code:medium",
        task_type="code",
        difficulty="medium",
        fingerprint="fp",
        ts=1.0,
        tau=0.7,
        policy="argmin",
        epsilon=0.0,
        chosen_model_id="m",
        escalated=False,
        candidates=[
            CandidateSnapshot(
                model_id="m",
                predicted_success=raw,
                confidence=0.6,
                est_cost_usd=0.001,
                propensity=1.0,
                raw_predicted_success=raw,
            )
        ],
    )
    rec.realized_model_id = "m"
    rec.realized_outcome = outcome
    rec.realized_quality = 1.0 if outcome == "success" else 0.0
    rec.feedback_ts = 2.0
    return rec


def calibration_demo(rng: random.Random) -> tuple[float, float]:
    """Model claims `raw` success but really succeeds at raw-0.2 (overconfident)."""
    rows: list[DecisionRecord] = []
    for i in range(2000):
        raw = rng.uniform(0.5, 0.99)
        true_p = max(0.0, raw - 0.2)
        outcome = "success" if rng.random() < true_p else "failure"
        rows.append(_decision(f"r{i}", raw, outcome))
    cal = fit_calibrators(rows, min_n=30, shrinkage_k=20.0, now=0.0)
    assert cal is not None
    pairs_raw = [
        (r.raw_predicted_success_chosen or 0.0, 1.0 if r.realized_outcome == "success" else 0.0)
        for r in rows
    ]
    ece_before, _ = _ece(pairs_raw, 10)
    pairs_cal = [(cal.transform("code", p), y) for p, y in pairs_raw]
    ece_after, _ = _ece(pairs_cal, 10)
    return ece_before, ece_after


def _cand(model_id: str, cost: float, predicted: float, width: float) -> CandidateScore:
    return CandidateScore(
        card=ModelCard(
            model_id=model_id, provider="p", input_cost_per_mtok=1, output_cost_per_mtok=1
        ),
        predicted_success=predicted,
        confidence=0.6,
        est_cost_usd=cost,
        est_cost_breakdown={},
        decision_basis=DecisionBasis.memory,
        score=predicted,
        interval_width=width,
    )


def collapse_demo(rng: random.Random, margin: float) -> dict[str, float]:
    """High bar (tau=0.85): cheap model sits just under tau with a wide interval; pricey is
    confidently over. Without the guard the cheap-but-plausible model is excluded -> collapse."""
    tau = 0.85
    picked_top = 0
    cost_sum = 0.0
    successes = 0
    n = 2000
    cheap_true, pricey_true = 0.80, 0.95
    for _ in range(n):
        cheap = _cand("cheap", 0.001, rng.uniform(0.78, 0.88), 0.20)
        pricey = _cand("pricey", 0.010, rng.uniform(0.90, 0.98), 0.05)
        rec, _fb, _ranked, _w = _optimize([cheap, pricey], tau=tau, collapse_margin=margin)
        if rec.card.model_id == "pricey":
            picked_top += 1
        cost_sum += rec.est_cost_usd
        true_p = pricey_true if rec.card.model_id == "pricey" else cheap_true
        successes += 1 if rng.random() < true_p else 0
    return {
        "top_model_share": picked_top / n,
        "mean_cost_usd": cost_sum / n,
        "success_rate": successes / n,
    }


def main() -> None:
    print("=" * 72)
    print("Phase 0/1 metrics demonstration (synthetic, deterministic, real code paths)")
    print("=" * 72)

    ece_before, ece_after = calibration_demo(random.Random(7))
    print("\n[P0.1] Calibration — model overconfident by 0.20")
    print(f"  ECE before remap : {ece_before:.4f}")
    print(f"  ECE after  remap : {ece_after:.4f}")
    print(f"  -> {100 * (1 - ece_after / ece_before):.0f}% lower calibration error")

    off = collapse_demo(random.Random(11), margin=0.0)
    on = collapse_demo(random.Random(11), margin=1.0)  # tau-aware default
    print("\n[P1.1] Routing-collapse guard (tau-aware) — high quality bar (tau=0.85)")
    print(f"  {'metric':<20}{'guard OFF':>12}{'guard ON':>12}")
    for k in ("top_model_share", "mean_cost_usd", "success_rate"):
        print(f"  {k:<20}{off[k]:>12.4f}{on[k]:>12.4f}")
    top_drop = 100 * (1 - on["top_model_share"] / max(off["top_model_share"], 1e-9))
    cost_drop = 100 * (1 - on["mean_cost_usd"] / max(off["mean_cost_usd"], 1e-9))
    succ_delta = on["success_rate"] - off["success_rate"]
    print(
        f"  -> top-model picks {top_drop:.0f}% lower, mean cost {cost_drop:.0f}% lower, "
        f"success {succ_delta:+.3f} (tunable via minima_collapse_margin; calibration mitigates)"
    )
    print()


if __name__ == "__main__":
    main()
