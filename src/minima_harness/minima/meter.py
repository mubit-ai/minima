"""CostMeter — per-prompt cost observability for a MinimaAgent run.

Owned by :class:`MinimaAgent` (the routing decision isn't part of the ``AgentEvent``
stream, so the meter is fed directly from ``prompt()`` rather than via ``subscribe()``).
Accumulates one row per prompt — model picked, why, est vs actual $, savings vs the
configured baseline, quality, outcome — and renders a report + summary totals. This is
the "see exactly what you spend and why" surface: the data already flowed to Minima; the
meter just surfaces it to the human.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from minima_harness.minima.router import RoutingResult


@dataclass(slots=True)
class CostRow:
    label: str
    model: str
    decision_basis: str
    est_cost_usd: float
    actual_cost_usd: float
    baseline_cost_usd: float | None
    quality: float | None
    outcome: str
    turns: int = 0


@dataclass(slots=True)
class CostTotals:
    n: int = 0
    est_cost_usd: float = 0.0
    actual_cost_usd: float = 0.0
    baseline_cost_usd: float = 0.0
    baseline_rows: int = 0  # prompts that had a baseline to compare against
    successes: int = 0

    @property
    def savings_usd(self) -> float:
        return self.baseline_cost_usd - self.actual_cost_usd

    @property
    def savings_pct(self) -> float:
        if self.baseline_cost_usd <= 0:
            return 0.0
        return 100.0 * self.savings_usd / self.baseline_cost_usd

    @property
    def success_rate(self) -> float:
        return (100.0 * self.successes / self.n) if self.n else 0.0


class CostMeter:
    def __init__(self) -> None:
        self.rows: list[CostRow] = []

    def record(
        self,
        *,
        label: str,
        routing: RoutingResult | None,
        actual_cost_usd: float,
        quality: float | None,
        outcome: str,
        turns: int = 0,
    ) -> CostRow:
        row = CostRow(
            label=label,
            model=(routing.chosen_model_id if routing else None) or "(offline)",
            decision_basis=routing.decision_basis if routing else "-",
            est_cost_usd=routing.est_cost_usd if routing else 0.0,
            actual_cost_usd=actual_cost_usd,
            baseline_cost_usd=routing.baseline_cost_usd if routing else None,
            quality=quality,
            outcome=outcome,
            turns=turns,
        )
        self.rows.append(row)
        return row

    def totals(self) -> CostTotals:
        t = CostTotals()
        for r in self.rows:
            t.n += 1
            t.est_cost_usd += r.est_cost_usd
            t.actual_cost_usd += r.actual_cost_usd
            if r.baseline_cost_usd is not None:
                t.baseline_cost_usd += r.baseline_cost_usd
                t.baseline_rows += 1
            if r.outcome == "success":
                t.successes += 1
        return t

    def report(self) -> str:
        if not self.rows:
            return "(cost meter: no prompts recorded)"
        cols = [
            "label",
            "model",
            "basis",
            "est$",
            "actual$",
            "save$",
            "turns",
            "quality",
            "outcome",
        ]
        rendered = [
            {
                "label": r.label,
                "model": r.model,
                "basis": r.decision_basis,
                "est$": f"{r.est_cost_usd:.6f}",
                "actual$": f"{r.actual_cost_usd:.6f}",
                "save$": (
                    f"{r.baseline_cost_usd - r.actual_cost_usd:.6f}"
                    if r.baseline_cost_usd is not None
                    else "-"
                ),
                "turns": str(r.turns),
                "quality": f"{r.quality:.2f}" if r.quality is not None else "-",
                "outcome": r.outcome,
            }
            for r in self.rows
        ]
        widths = {c: max(len(c), max(len(str(row[c])) for row in rendered)) for c in cols}
        header = "  ".join(c.ljust(widths[c]) for c in cols)
        lines = [header, "-" * len(header)]
        for row in rendered:
            lines.append("  ".join(str(row[c]).ljust(widths[c]) for c in cols))
        t = self.totals()
        lines.append("")
        lines.append(
            f"total actual ${t.actual_cost_usd:.6f} | "
            f"baseline ${t.baseline_cost_usd:.6f} ({t.baseline_rows} rows) | "
            f"savings {t.savings_pct:.1f}% (${t.savings_usd:.6f}) | "
            f"success {t.success_rate:.1f}% ({t.successes}/{t.n})"
        )
        return "\n".join(lines)
