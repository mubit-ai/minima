from __future__ import annotations

import json
from pathlib import Path

from minima_harness.session import SessionManager
from minima_harness.tui.customize import GLOBAL_DIR


class History:
    """Shell-style prompt history with prev/next cursor (None cursor = the 'new' position)."""

    def __init__(self, entries: list[str] | None = None) -> None:
        self.entries: list[str] = list(entries or [])
        self._i: int | None = None  # None = new (after the last); index = browsing position

    def add(self, text: str) -> None:
        text = text.strip()
        if text and (not self.entries or self.entries[-1] != text):
            self.entries.append(text)
        self._i = None

    def prev(self) -> str | None:
        """Move toward older; returns the entry (or None if there's no history)."""
        if not self.entries:
            return None
        if self._i is None:
            self._i = len(self.entries) - 1
        elif self._i > 0:
            self._i -= 1
        return self.entries[self._i]

    def next(self) -> str | None:
        """Move toward newer; returns the entry, '' when back at new, or None if already new."""
        if self._i is None:
            return None
        self._i += 1
        if self._i >= len(self.entries):
            self._i = None
            return ""
        return self.entries[self._i]


def _path(cwd: Path) -> Path:
    slug = SessionManager().slug_for(cwd)
    return GLOBAL_DIR / "history" / f"{slug}.jsonl"


def load_history(cwd: Path) -> list[str]:
    path = _path(cwd)
    if not path.is_file():
        return []
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return out


def append_history(cwd: Path, text: str) -> None:
    path = _path(cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(text) + "\n")
    except OSError:  # noqa: BLE001
        pass
