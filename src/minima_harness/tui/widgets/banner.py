from __future__ import annotations

from rich.text import Text

from minima_harness.tui.theme import current_theme, get_theme


def render_banner(reason: str) -> Text:
    t = get_theme(current_theme())
    return Text(
        f"⚠ routing offline: {reason} — /reconnect to retry Minima",
        style=f"bold {t['warning']}",
    )
