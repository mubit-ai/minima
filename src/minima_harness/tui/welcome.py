from __future__ import annotations

from typing import TYPE_CHECKING

from rich.console import Group
from rich.text import Text

from minima_harness.tui.theme import current_theme, get_theme

if TYPE_CHECKING:
    from minima_harness.tui.app import HarnessApp

# ANSI-Shadow-style block glyphs (6 rows). Built programmatically and joined row-wise so the
# columns always line up — never hand-concatenate ASCII art. Each letter's rows are equal width.
_GLYPHS: dict[str, list[str]] = {
    "M": ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
    "I": ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
    "N": ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
    "A": [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
}


def _ascii_banner(word: str) -> str:
    return "\n".join(" ".join(_GLYPHS[ch][row] for ch in word) for row in range(6))


BANNER = _ascii_banner("MINIMA")  # ~51 cols wide; the hero of the launch splash

# A one-line workflow strap. Live state lives in the footer (the single status surface), not
# here — the splash is pure onboarding. Auto-collapses on the first prompt; /banner toggles it.
DIAGRAM = "recommend → run → judge → feedback → memory"


def render_welcome(app: HarnessApp) -> Group:
    """The centered launch splash: MINIMA CLI banner + workflow strap + one onboarding hint.

    Carries NO live status (model/session/cost/theme — that's the footer's job) and NO
    duplicated key help.
    """
    t = get_theme(current_theme())
    accent, muted = t["accent"], t["muted"]
    banner = Text(BANNER, style=f"bold {accent}")
    subtitle = Text("CLI · cost-aware model routing", style=muted)
    strap = Text(DIAGRAM, style=muted)
    hint = Text("type a prompt, or / for commands", style=muted)
    return Group(banner, Text(""), subtitle, Text(""), strap, hint)
