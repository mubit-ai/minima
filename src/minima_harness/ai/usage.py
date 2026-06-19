"""Cost computation: realized tokens x per-model prices -> USD.

Feeds Minima's ``actual_cost_usd`` feedback field. Keeping the realized-cost basis in
the harness (rather than echoing Minima's *prior* ``est_cost_usd``) lets Minima climb
estimate -> observed -> rescaled, which is its single biggest accuracy lever.
"""

from __future__ import annotations

from minima_harness.ai.types import Cost, Model, Usage

# Registry prices are per-million tokens; divide token counts by 1e6.
_PER_MTOK = 1_000_000.0


def cost_for(model: Model, usage: Usage) -> Cost:
    """Compute the USD cost of ``usage`` against ``model``'s price table."""
    in_usd = usage.input * model.cost.input / _PER_MTOK
    out_usd = usage.output * model.cost.output / _PER_MTOK
    total = in_usd + out_usd
    # Cache accounting is informational only; not folded into ``total`` (cache reads are
    # cheap, and providers rarely report them per-turn in a way Minima can reconcile).
    return Cost(input=in_usd, output=out_usd, total=total)


def attach_cost(model: Model, usage: Usage) -> Usage:
    """Return ``usage`` with its ``cost`` field populated for ``model``."""
    usage.cost = cost_for(model, usage)
    return usage
