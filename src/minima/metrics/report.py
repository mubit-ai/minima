"""Ops-side calibration/savings report over the shared decision-log DB.

Usage: ``minima-calibration-report [--days 30] [--org <org_id>]``. Reads the SQLite
decision log at MINIMA_SQLITE_PATH directly (all orgs unless --org), so it works
without the API and without a tenant key. With the in-memory store there is nothing
to read across processes — run the service with MINIMA_RECOMMENDATION_STORE=sqlite.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict

from minima.config import get_settings
from minima.metrics.calibration import calibration_by_task_type, cusum_flags, routing_health
from minima.metrics.savings import summarize
from minima.recommender.decisionlog import DecisionRecord, SqliteDecisionLog

_SECONDS_PER_DAY = 86_400.0


def _print_org(org_id: str, rows: list[DecisionRecord], settings) -> None:  # noqa: ANN001
    health = routing_health(rows)
    reports = calibration_by_task_type(
        rows,
        n_bins=settings.minima_calibration_bins,
        shrinkage_k=settings.minima_calibration_shrinkage_k,
    )
    flags = cusum_flags(rows, k=settings.minima_cusum_k, h=settings.minima_cusum_h)
    savings = summarize(rows)

    print(f"\n=== org: {org_id} ===")
    print(f"health:   {json.dumps(health)}")
    est, real = savings.estimated, savings.realized
    print(
        f"savings:  est vs premium ${est.savings_vs_premium_usd:.4f} over {est.n} recs"
        f" | est vs declared ${est.savings_vs_declared_usd:.4f} over {est.n_declared}"
        f" | realized(vs est premium) ${real.savings_vs_premium_est_usd:.4f}"
        f" over {real.n_reconciled} reconciled"
    )
    print("calibration (ECE by task_type, shrunk toward global):")
    for r in reports:
        print(
            f"  {r.slice_key:<16} n={r.n:<6} ece={r.ece:.4f}"
            f" shrunk={r.ece_shrunk:.4f} quality={r.ece_quality:.4f}"
        )
    if flags:
        print("drift flags (CUSUM):")
        for f in flags[:20]:
            print(
                f"  {f.cluster} / {f.model_id}: {f.direction}"
                f" (S={f.statistic}, n={f.n})"
            )
    else:
        print("drift flags: none")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=float, default=30.0)
    parser.add_argument("--org", default=None, help="restrict to one org id")
    parser.add_argument("--json", action="store_true", help="emit raw JSON instead of text")
    args = parser.parse_args()

    settings = get_settings()
    backend = SqliteDecisionLog(
        settings.minima_sqlite_path, settings.minima_decision_log_retention_days
    )
    since = time.time() - args.days * _SECONDS_PER_DAY
    rows = backend.rows(since=since, org_id=args.org)
    if not rows:
        print(
            f"no decisions in the last {args.days:g} days"
            f" (db: {settings.minima_sqlite_path}"
            f"{', org: ' + args.org if args.org else ''})"
        )
        return

    by_org: dict[str, list[DecisionRecord]] = {}
    for r in rows:
        by_org.setdefault(r.org_id, []).append(r)

    if args.json:
        payload = {
            org: {
                "health": routing_health(org_rows),
                "savings": asdict(summarize(org_rows)),
                "calibration": [
                    asdict(rep)
                    for rep in calibration_by_task_type(
                        org_rows,
                        n_bins=settings.minima_calibration_bins,
                        shrinkage_k=settings.minima_calibration_shrinkage_k,
                    )
                ],
                "drift_flags": [
                    asdict(f)
                    for f in cusum_flags(
                        org_rows, k=settings.minima_cusum_k, h=settings.minima_cusum_h
                    )
                ],
            }
            for org, org_rows in sorted(by_org.items())
        }
        print(json.dumps(payload, indent=2))
        return

    print(f"decision-log report — last {args.days:g} days, {len(rows)} decisions")
    for org, org_rows in sorted(by_org.items()):
        _print_org(org, org_rows, settings)


if __name__ == "__main__":
    main()
