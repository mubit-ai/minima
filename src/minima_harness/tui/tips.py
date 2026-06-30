from __future__ import annotations

import json

from minima_harness.tui.customize import GLOBAL_DIR

# Persisted rotation cursor: each launch / turn / `/tip` advances it so the user sees a *new* tip
# in order rather than the same one (or a random repeat). Lives next to config.env.
STATE_FILE = GLOBAL_DIR / "tips_state.json"

# Curated tips, each spotlighting one distinctive Minima command — the things a new user would
# never find on their own. Every entry leads with the `/command` so the takeaway is the command.
# Plain strings (no Textual import) so this module unit-tests in isolation.
TIPS: tuple[str, ...] = (
    "/recall pulls lessons from past sessions, even across projects",
    "/escalate auto-retries on a stronger model when answer quality looks thin",
    "/confirm shows the routing trade-off panel before each turn so you pick the model",
    "/model auto lets Minima cost-route; /model <id> pins one",
    "/cache reuses a near-duplicate answer for $0 — toggle the semantic cache",
    "/optimize trims your system prompt via Mubit to save tokens",
    "/ledger set <goal> tracks spend against a budget across the whole goal",
    "/judge toggles LLM quality judging of each answer",
    "/edits forces a diff review before any file write",
    "/tree, /fork and /clone branch and revisit your session history",
    "/thoughts streams the model's reasoning live",
    "/cost opens the meter: estimated vs. actual spend per turn",
    "/compact summarizes older context when the window fills up",
    "/prompt inspects the layered Mubit + local system prompt",
    "/stats shows analytics across your last 10 sessions",
)


def format_tip(body: str) -> str:
    """Prefix a tip body with the lightbulb glyph used across the welcome splash and spinner."""
    return f"💡 {body}"


def pick(index: int) -> str:
    """The tip at ``index``, wrapping around the curated list."""
    return TIPS[index % len(TIPS)]


def _read_index() -> int:
    try:
        return int(json.loads(STATE_FILE.read_text()).get("index", 0))
    except Exception:  # noqa: BLE001 - missing/corrupt/unreadable state → start from 0
        return 0


def advance() -> int:
    """Return the next rotation index and persist it (mod the list length).

    Best-effort: an unwritable HOME must never crash the app, so a failed write just means the
    next launch re-reads the old value — the cycle still rotates within the running session.
    """
    nxt = (_read_index() + 1) % len(TIPS)
    try:
        GLOBAL_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"index": nxt}))
    except Exception:  # noqa: BLE001 - read-only HOME / no perms: fall back to in-memory value
        pass
    return nxt
