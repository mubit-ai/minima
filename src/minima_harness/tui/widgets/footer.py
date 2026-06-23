from __future__ import annotations

from rich.text import Text

from minima_harness.minima.meter import CostMeter
from minima_harness.tui.theme import current_theme, get_theme


def render_footer(
    cwd: str,
    session_id: str,
    model: str,
    basis: str,
    meter: CostMeter,
    input_tokens: int,
    output_tokens: int,
    cache_read: int,
    cache_write: int,
    ctx_pct: float,
    routing_offline: bool,
    route_mode: str = "auto",
) -> Text:
    t = get_theme(current_theme())
    totals = meter.totals()
    tokens = f"↑{input_tokens} ↓{output_tokens}"
    if cache_read:
        tokens += f" ⚡{cache_read}"  # tokens served from the prompt cache this turn
    # Cost is Minima's whole pitch, so make savings-vs-baseline first-class: show the
    # realized spend and, once any turn had a baseline to compare against, the % saved.
    cost = f"${totals.actual_cost_usd:.4f}"
    if totals.baseline_rows:
        pct = totals.savings_pct
        cost += f" ({'save' if pct >= 0 else 'over'} {abs(pct):.0f}% vs base)"
    bits = [
        f"model: {model} ▸ {basis}",
        f"route: {route_mode}",
        f"ctx {ctx_pct:.0f}%",
        tokens,
        cost,
        f"sess {session_id[:24]}",
    ]
    if routing_offline:
        bits.append("[routing offline]")
    text = Text(" · ").join(Text(b) for b in bits)
    text.stylize(f"fg {t['muted']}")
    return text
