"""Phase 6 — markdown dashboard from /health + /savings + /calibration.

Read-only: no feedback, no writes, no LLM. Renders a single markdown report so you can see
savings, routing health, and calibration truthfulness in one place. Defaults to the default
namespace lane (your warm data); pass --namespace to scope, --days to widen the window.

    set -a; source .env; set +a
    uv run python tests/playground/report.py
    uv run python tests/playground/report.py --namespace playground-p1 --out runs/report.md
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime
from typing import Any

from minima_client import AsyncMinimaClient

DEFAULT_URL = "http://localhost:8088"


def pct(x: float, denom: float) -> str:
    if denom <= 0:
        return "-"
    return f"{100 * x / denom:.0f}%"


def usd(x: float | None) -> str:
    return f"${x:.4f}" if x is not None else "-"


def md_health(h: dict[str, Any]) -> list[str]:
    m = h.get("mubit", {})
    cat = h.get("catalog", {})
    r = h.get("reasoner", {})
    out = ["## Health", ""]
    out.append(f"- status: **{h.get('status', '?')}**  (auth={h.get('auth', '?')})")
    out.append(
        f"- mubit: reachable={m.get('reachable')}  http={m.get('status_code', '?')}  "
        f"org={m.get('org_id', '?')}"
    )
    out.append(
        f"- catalog: {cat.get('models', '?')} models  stale={cat.get('stale')}  "
        f"source={cat.get('cost_source', '?')}  version={cat.get('version', '?')}"
    )
    out.append(f"- reasoner: configured={r.get('configured')}  provider={r.get('provider', '?')}")
    return out + [""]


def md_savings(s: dict[str, Any]) -> list[str]:
    ns = s.get("namespace") or "default"
    summ = s.get("summary", {}) or {}
    est, real = summ.get("estimated", {}) or {}, summ.get("realized", {}) or {}
    h = s.get("health", {}) or {}
    out = [f"## Savings  ({s.get('days', '?')}d, namespace=`{ns}`)", ""]

    rec_cost = est.get("cost_recommended_usd", 0.0)
    prem_cost = est.get("cost_premium_usd", 0.0)
    sav_prem = est.get("savings_vs_premium_usd", 0.0)
    out.append("### Estimated")
    out.append(
        f"- recommendations: {est.get('n', 0)}  (declared baseline: {est.get('n_declared', 0)})"
    )
    out.append(f"- recommended cost: {usd(rec_cost)}  | premium cost: {usd(prem_cost)}")
    out.append(f"- savings vs premium: {usd(sav_prem)} ({pct(sav_prem, prem_cost)})")

    rec_real = real.get("realized_cost_usd", 0.0)
    prem_real = real.get("est_cost_premium_usd", 0.0)
    sav_real = real.get("savings_vs_premium_est_usd", 0.0)
    out.append("")
    out.append("### Realized (reconciled)")
    out.append(
        f"- reconciled: {real.get('n_reconciled', 0)}/{est.get('n', 0)}  "
        f"realized cost: {usd(rec_real)}"
    )
    out.append(f"- savings vs premium (est): {usd(sav_real)} ({pct(sav_real, prem_real)})")
    out.append("")

    out.append("### Routing health")
    cov = h.get("feedback_coverage", 0)
    out.append(f"- recommendations: {h.get('recommendations', 0)}  feedback_coverage: {cov:.0%}")
    out.append(
        f"- escalation_rate: {h.get('escalation_rate', 0):.0%}  "
        f"exploration_share: {h.get('exploration_share', 0):.0%}  "
        f"epsilon_policy_share: {h.get('epsilon_policy_share', 0):.0%}"
    )
    out.append(
        f"- success_rate: {h.get('success_rate', 0):.0%}  "
        f"top_model_share: {h.get('top_model_share', 0):.0%}  "
        f"cheapest_model_share: {h.get('cheapest_model_share', 0):.0%}"
    )
    out.append(
        f"- cost_position: {h.get('cost_position', 0):.2f}  "
        f"shadow_agreement: {h.get('shadow_agreement', 0):.0%}  "
        f"late_feedback_share: {h.get('late_feedback_share', 0):.0%}"
    )
    return out + [""]


def md_calibration(c: dict[str, Any]) -> list[str]:
    out = ["## Calibration  (is predicted_success telling the truth?)", ""]
    flags = c.get("drift_flags") or []
    if flags:
        out.append(f"**drift flags:** {', '.join(str(f) for f in flags)}")
    else:
        out.append("**drift flags:** none")
    out.append("")
    for rep in c.get("reports", []) or []:
        key = rep.get("slice_key", "?")
        n = rep.get("n", 0)
        ece = rep.get("ece")
        ece_shrunk = rep.get("ece_shrunk")
        line = f"- `{key}`  n={n}  ECE={ece:.3f}" if ece is not None else f"- `{key}`  n={n}  ECE=-"
        if ece_shrunk is not None and ece is not None and abs(ece_shrunk - ece) > 1e-9:
            line += f"  (shrunk={ece_shrunk:.3f})"
        out.append(line)
    out.append("")
    out.append("_ECE = expected calibration error (lower is better). n<MIN_N => identity (no-op)._")
    return out + [""]


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.environ.get("MINIMA_URL", DEFAULT_URL))
    key_default = os.environ.get("MINIMA_KEY") or os.environ.get("MUBIT_API_KEY")
    ap.add_argument("--key", default=key_default)
    ap.add_argument("--namespace", default=None, help="scope (default: the default lane)")
    ap.add_argument("--days", type=float, default=7.0)
    ap.add_argument("--out", default="", help="optional output .md path")
    args = ap.parse_args()

    if not args.key:
        print("ERROR: set MUBIT_API_KEY (or MINIMA_KEY) before running.", file=sys.stderr)
        return 2

    async with AsyncMinimaClient(args.url, api_key=args.key, timeout=60.0) as minima:
        h = await minima.health()
        savings = (await minima.savings(namespace=args.namespace, days=args.days)).model_dump(
            mode="json"
        )
        cal = (await minima.calibration(namespace=args.namespace, days=args.days)).model_dump(
            mode="json"
        )

    lines: list[str] = []
    lines.append("# Minima dashboard")
    lines.append("")
    lines.append(f"_generated {datetime.now(UTC).isoformat(timespec='seconds')}_")
    lines.append(f"_url={args.url}  days={args.days:g}_")
    lines.append("")
    lines += md_health(h)
    lines += md_savings(savings)
    lines += md_calibration(cal)

    report = "\n".join(lines)
    if args.out:
        from pathlib import Path

        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(report + "\n")
        print(f"wrote {args.out}")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
