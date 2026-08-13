"""Example 7 — The ops tour: is routing working, and what did it save me?

Examples 1–6 all *write* to Minima. This one only reads: a single pass over every
reporting endpoint, in the order an operator actually asks the questions.

    capabilities()   what does this deployment support?
    savings()        what did routing save — estimated AND realized?
    calibration()    is predicted_success telling the truth?
    policy_value()   how much regret vs. an oracle over the decision log?
    memory_health()  is the memory lane healthy — stale, contradictory, thin?
    diagnose()       "here is how this error failed before"

On a cold org most of these are empty — that is not an error, it is the honest answer.
Each section says so and moves on.

    uv run python examples/07_observability.py

Set MINIMA_URL (default http://localhost:8080) and, in multi-tenant mode, MINIMA_KEY.
"""

from __future__ import annotations

import os

from minima_client import MinimaClient, MinimaError

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
KEY = os.environ.get("MINIMA_KEY")  # only needed in multi-tenant mode
DAYS = float(os.environ.get("MINIMA_REPORT_DAYS", "7"))

COLD = "  no data yet — run examples/02_recommend_and_feedback.py a few times first"


def section(title: str) -> None:
    print(f"\n== {title} ==")


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def main() -> None:
    with MinimaClient(URL, api_key=KEY) as minima:
        try:
            minima.health()
        except MinimaError as exc:
            print(f"could not reach Minima at {URL}: {exc}")
            print("start it with `make run`, or set MINIMA_URL to a live deployment.")
            return

        # ---- what does this deployment support? -------------------------------------
        section("capabilities")
        try:
            caps = minima.capabilities()
            print(f"  api_version         {caps.api_version}")
            print(f"  workflow endpoint   {caps.workflow}")
            print(f"  plan endpoint       {caps.plan}")
            print(f"  honored constraints {', '.join(caps.honored_constraints) or '(none)'}")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")

        # ---- what did routing save? --------------------------------------------------
        # Two bases, never conflated. `estimated` prices every decision off the catalog.
        # `realized` counts only decisions you closed the loop on with real usage — the
        # number to quote. Its premium baseline stays estimated (the premium model was
        # never actually run), which is why the field is named ..._est_usd.
        section(f"savings (last {DAYS:g}d)")
        try:
            sv = minima.savings(days=DAYS)
            est, real = sv.summary.estimated, sv.summary.realized
            if est.n == 0:
                print(COLD)
            else:
                for key, value in sorted(sv.health.items()):
                    print(f"  health/{key}: {value}")
                print(f"  estimated over {est.n} decisions")
                print(f"    recommended  ${est.cost_recommended_usd:.4f}")
                print(f"    all-premium  ${est.cost_premium_usd:.4f}")
                print(f"    saved        ${est.savings_vs_premium_usd:.4f}")
                if real.n_reconciled == 0:
                    print("  realized: 0 reconciled decisions — send /v1/feedback with real"
                          " input_tokens/output_tokens/actual_cost_usd to populate this")
                else:
                    print(f"  realized over {real.n_reconciled} reconciled decisions")
                    print(f"    actually paid ${real.realized_cost_usd:.4f}")
                    print(f"    saved (vs est premium) ${real.savings_vs_premium_est_usd:.4f}")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")

        # ---- is predicted_success honest? ---------------------------------------------
        # ECE = expected calibration error: mean gap between predicted and realized
        # success. Lower is better; ~0.05 is tight, >0.20 means the numbers are decor.
        # Only rows with trusted evidence_source count as labels.
        section(f"calibration (last {DAYS:g}d)")
        try:
            cal = minima.calibration(days=DAYS)
            # A slice with n=0 is a placeholder, not a measurement — an ECE of 0.000
            # over zero labels reads as "perfectly calibrated" and means nothing.
            scored = [r for r in cal.reports if r.n > 0]
            if not scored:
                print(COLD)
            for rep in scored:
                print(f"  {rep.slice_key:<20} n={rep.n:<5} ECE={rep.ece:.3f} "
                      f"(shrunk {rep.ece_shrunk:.3f})")
            for flag in cal.drift_flags:
                print(f"  ⚠ drift: {flag.model_id} in {flag.cluster} is "
                      f"{flag.direction} (n={flag.n}, stat={flag.statistic:.2f})")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")

        # ---- how much better could routing have been? ---------------------------------
        # Counterfactual estimates are only as good as the log they replay:
        # stochastic_share is the fraction of decisions with a non-degenerate propensity
        # (the genuinely counterfactual-capable part), and estimator_disagreement means
        # "no single number here is trustworthy".
        section(f"policy value (last {DAYS:g}d)")
        try:
            pv = minima.policy_value(days=DAYS)
            rep = pv.report
            if rep.n_trusted == 0:
                print(COLD)
            else:
                print(f"  trusted rows {rep.n_trusted}/{rep.n_total_reconciled}  "
                      f"stochastic {pct(rep.stochastic_share)}")
                print(f"  regret vs oracle  {rep.regret_vs_oracle:+.3f}")
                if rep.estimator_disagreement:
                    print("  ⚠ estimators disagree — treat these values as directional only")
                for pol in rep.policies:
                    print(f"    {pol.policy:<20} success={pol.success_value:.3f} "
                          f"cost=${pol.cost_value:.5f} matched={pct(pol.matched_share)}")
            for warning in pv.warnings:
                print(f"  ⚠ {warning}")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")

        # ---- is the memory lane healthy? ----------------------------------------------
        section("memory health")
        try:
            mh = minima.memory_health()
            total = sum(mh.entry_counts.values())
            print(f"  lane {mh.lane or '(default)'} — {total} entries")
            for kind, count in sorted(mh.entry_counts.items()):
                print(f"    {kind:<20} {count}")
            print(f"  stale {mh.stale_entries} · contradictions {mh.contradictions} · "
                  f"low-confidence {mh.low_confidence_count} · "
                  f"promotable {mh.promotion_candidates}")
            for reset in mh.posterior_resets:
                print(f"  ⚠ posterior reset active: {reset.model} ({reset.cause})")
            for warning in mh.warnings:
                print(f"  ⚠ {warning}")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")

        # ---- has this error been seen before? -----------------------------------------
        # The recovery-time question: paste a real error from your logs here and Minima
        # returns the failure lessons its memory matched against it.
        section("diagnose")
        error_text = "TypeError: 'NoneType' object is not subscriptable in parse_invoice()"
        print(f"  querying: {error_text}")
        try:
            dg = minima.diagnose(error_text, limit=3)
            if not dg.failure_lessons:
                print("  no matching failure lessons — memory has not seen this shape yet")
            for lesson in dg.failure_lessons:
                print(f"    [{lesson.importance or 'n/a'} · {lesson.confidence:.2f}] "
                      f"{lesson.content[:100]}")
            if dg.summary:
                print(f"  summary: {dg.summary}")
        except MinimaError as exc:
            print(f"  unavailable: {exc}")


if __name__ == "__main__":
    main()
