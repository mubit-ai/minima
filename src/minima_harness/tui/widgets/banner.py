from __future__ import annotations

from rich.text import Text

from minima_harness.tui.theme import current_theme, get_theme


def render_banner(reason: str) -> Text:
    """Genuine offline fallback: Minima was unreachable, so /reconnect is the action."""
    t = get_theme(current_theme())
    return Text(
        f"⚠ routing offline: {reason} — /reconnect to retry Minima",
        style=f"bold {t['warning']}",
    )


def render_config_banner(reason: str) -> Text:
    """Routing is off due to a config/auth problem (no/invalid key). Retrying alone won't
    fix it, so this deliberately omits the '/reconnect to retry' framing and instead carries
    the actionable next step in ``reason`` (e.g. 'add MUBIT_API_KEY via /config')."""
    t = get_theme(current_theme())
    return Text(f"⚠ routing offline: {reason}", style=f"bold {t['warning']}")


def render_notice(reason: str) -> Text:
    """A non-offline heads-up (a surfaced warning or context-near-limit). Deliberately omits
    the 'routing offline'/'/reconnect' framing — routing succeeded; this is just FYI."""
    t = get_theme(current_theme())
    return Text(f"⚠ {reason}", style=f"bold {t['warning']}")
