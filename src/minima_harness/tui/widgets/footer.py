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
    thinking_level: str = "off",
    goal: str = "",
) -> Text:
    """The single canonical status surface. Per-segment colour by *meaning* (not blanket-dim):
    model in user-colour, cost in amber, savings/ctx/route warnings in red — so Minima's
    cost-routing value reads at a glance. Layout: MODES  |  METRICS.
    """
    t = get_theme(current_theme())
    dim = t.get("footer_dim", t["muted"])
    accent = t.get("footer_accent", t["accent"])
    user, warn = t["user"], t["warning"]
    totals = meter.totals()
    out = Text(no_wrap=True)

    def seg(label: str, value: str, style: str) -> None:
        out.append(label, style=dim)
        out.append(value, style=style)

    # --- modes block (what am I doing) ---
    seg("model: ", f"{model} ▸ {basis}", warn if basis == "offline" else user)
    out.append("  ·  ", style=dim)
    seg("route: ", route_mode, warn if route_mode == "confirm" else dim)
    out.append("  ·  ", style=dim)
    think_style = warn if thinking_level == "high" else (dim if thinking_level == "off" else accent)
    seg("think: ", thinking_level, think_style)
    if goal:
        out.append("  ·  ", style=dim)
        seg("ledger: ", goal, accent)

    out.append("   |   ", style=dim)

    # --- metrics block (what has it cost) ---
    seg("ctx ", f"{ctx_pct:.0f}%", warn if ctx_pct > 80 else dim)
    out.append("  ·  ", style=dim)
    out.append(f"↑{input_tokens} ↓{output_tokens}", style=dim)
    if cache_read:
        out.append(f" ⚡{cache_read}", style=accent)  # tokens served from the prompt cache
    out.append("  ·  ", style=dim)
    out.append(f"${totals.actual_cost_usd:.4f}", style=accent)
    if totals.baseline_rows:
        pct = totals.savings_pct
        out.append(
            f" ({'save' if pct >= 0 else 'over'} {abs(pct):.0f}% vs base)",
            style=accent if pct >= 0 else warn,
        )
    out.append("  ·  ", style=dim)
    marker = "◈ " if session_id == "ephemeral" else ""
    out.append(f"sess {marker}{session_id[:24]}", style=dim)
    if routing_offline:
        out.append("   ")
        out.append("[routing offline]", style=f"bold {warn}")
    return out
