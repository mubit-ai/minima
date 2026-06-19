from __future__ import annotations

from rich.text import Text

from minima_harness.minima.meter import CostMeter
from minima_harness.tui.theme import get_theme


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
) -> Text:
    t = get_theme("dark")
    totals = meter.totals()
    bits = [
        cwd,
        f"sess {session_id[:4]}",
        f"↑{input_tokens} ↓{output_tokens} R{cache_read} W{cache_write}",
        f"${totals.actual_cost_usd:.4f}",
        f"ctx {ctx_pct:.0f}%",
        model,
    ]
    if routing_offline:
        bits.append("[routing offline]")
    text = Text(" · ").join(Text(b) for b in bits)
    text.stylize(f"fg {t['muted']}")
    return text
