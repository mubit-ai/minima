from __future__ import annotations

from typing import TYPE_CHECKING

from rich.console import Group
from rich.text import Text

from minima_harness.tui.theme import current_theme, get_theme

if TYPE_CHECKING:
    from minima_harness.tui.app import HarnessApp

DIAGRAM = """\
        ╭──────────────╮
   ┌───▶│   recommend  │   Minima picks the model
   │    ╰──────┬───────╯
   │           ▼
   │    ╭──────────────╮    ╭─────────╮
   │    │     run      │───▶│  judge  │   quality 0-1
   │    ╰──────┬───────╯    ╰─────────╯
   │           │ model + your tools
   │    ╭──────▼───────╮
   └───▶│   feedback   │   realized cost / tokens / outcome
        ╰──────────────╯
              ▼
           memory
"""


def render_welcome(app: HarnessApp) -> Group:
    """ASCII diagram + a live status panel for the startup transcript bubble."""
    t = get_theme(current_theme())
    accent, muted, user = t["accent"], t["muted"], t["user"]

    diagram = Text(DIAGRAM.rstrip(), style=accent)
    title = Text("minima-harness", style=f"bold {user}")
    sub = Text("recommend → run → judge → feedback", style=muted)

    session_label = app.session.display_name or (
        app.session.path.stem if app.session.path else "ephemeral"
    )
    model = app._footer_state.get("model", "auto")
    ntools = len(app._tools)
    context = "AGENTS.md ✓" if (app.cwd / "AGENTS.md").exists() else "AGENTS.md ·"
    status = Text(
        f"session: {session_label} · model: {model} · tools: {ntools} "
        f"· context: {context} · theme: {current_theme()}",
        style=muted,
    )
    hint = Text(
        "type a prompt + Enter · ↑/↓ history · / browse commands · Shift+Tab thinking · Esc abort",
        style=muted,
    )
    palette = Text("→ /commands  to open the full command palette", style=accent)

    return Group(diagram, Text(""), title, sub, Text(""), status, hint, palette, Text(""))
