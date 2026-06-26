from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from rich.console import Group
from rich.text import Text

from minima_harness.tui.theme import current_theme, get_theme

if TYPE_CHECKING:
    from minima_harness.tui.app import HarnessApp


def selection_hint(mouse_on: bool) -> str:
    """One-line guidance for selecting/copying text given the current mouse mode.

    With mouse capture ON the wheel scrolls but the terminal's own click-drag selection is
    suppressed — so to copy you either use the in-app selection (drag + ⌘/Ctrl+C) or hold the
    terminal's bypass modifier (Option on macOS, Shift on Linux) to force native selection.
    """
    if not mouse_on:
        return "native mouse select & copy · scroll with PageUp/PageDown · /mouse to toggle"
    modifier = "⌥ Option" if sys.platform == "darwin" else "Shift"
    return f"scroll: wheel/PgUp · to select+copy hold {modifier} & drag · /mouse toggles"

def _needs_setup() -> bool:
    """No configured provider key (across the whole provider catalog) → first-run nudge."""
    from minima_harness.ai.provider_catalog import configured_providers

    return not configured_providers()

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
    # justify="center" centers each line within the (auto-width = banner-width) splash widget, so
    # the subtitle/strap/hint sit centered under the banner. The banner's 6 rows are equal width,
    # so centering them keeps the ASCII art aligned.
    banner = Text(BANNER, style=f"bold {accent}", justify="center")
    subtitle = Text("CLI · cost-aware model routing", style=muted, justify="center")
    strap = Text(DIAGRAM, style=muted, justify="center")
    parts = [banner, Text(""), subtitle, Text(""), strap]
    if _needs_setup():
        parts.append(
            Text(
                "no API keys found — run  minima config  to add them",
                style=t.get("warning", accent),
                justify="center",
            )
        )
    parts.append(Text("type a prompt, or / for commands", style=muted, justify="center"))
    parts.append(
        Text(selection_hint(getattr(app, "_mouse_enabled", True)), style=muted, justify="center")
    )
    return Group(*parts)
