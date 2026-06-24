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
    """Compute the true USD cost of ``usage`` against ``model``'s price table.

    Cache reads/writes ARE folded into ``total`` (read ~0.1x, write ~1.25x the input
    rate). Anthropic reports ``input`` as the *uncached* portion only, so omitting the
    cache components understated realized cost; including them is what lets the cost meter
    show genuine savings and lets Minima's observed tier learn real post-cache economics.
    """
    in_usd = usage.input * model.cost.input / _PER_MTOK
    out_usd = usage.output * model.cost.output / _PER_MTOK
    cache_read_usd = usage.cache_read * model.cost.cache_read / _PER_MTOK
    cache_write_usd = usage.cache_write * model.cost.cache_write / _PER_MTOK
    total = in_usd + out_usd + cache_read_usd + cache_write_usd
    return Cost(
        input=in_usd,
        output=out_usd,
        cache_read=cache_read_usd,
        cache_write=cache_write_usd,
        total=total,
    )


def attach_cost(model: Model, usage: Usage) -> Usage:
    """Return ``usage`` with its ``cost`` field populated for ``model``."""
    usage.cost = cost_for(model, usage)
    return usage
