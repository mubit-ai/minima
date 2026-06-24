"""Render a mutating tool call (edit/write) as a unified diff for the approval modal."""

from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any

_MAX_LINES = 240


def render_tool_diff(tool_name: str, args: Any) -> str:
    """Unified-diff preview of what an edit/write tool would change. Pure (reads the file)."""
    if tool_name == "write":
        return _write_diff(args)
    if tool_name == "edit":
        return _edit_diff(args)
    return f"{tool_name}: {args}"


def _read_lines(path: str) -> list[str] | None:
    try:
        return Path(path).expanduser().read_text(encoding="utf-8").splitlines()
    except Exception:  # noqa: BLE001 - missing/binary file -> treat as new
        return None


def _edit_diff(args: Any) -> str:
    path = getattr(args, "path", "?")
    old = getattr(args, "old_string", "").splitlines()
    new = getattr(args, "new_string", "").splitlines()
    diff = difflib.unified_diff(old, new, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="")
    return _truncate("\n".join(diff) or f"edit {path} (no textual change)")


def _write_diff(args: Any) -> str:
    path = getattr(args, "path", "?")
    new = getattr(args, "content", "").splitlines()
    current = _read_lines(path)
    if current is None:
        body = "\n".join(f"+{line}" for line in new)
        return _truncate(f"--- /dev/null\n+++ b/{path} (new file)\n{body}")
    diff = difflib.unified_diff(
        current, new, fromfile=f"a/{path}", tofile=f"b/{path}", lineterm=""
    )
    return _truncate("\n".join(diff) or f"write {path} (no change)")


def _truncate(text: str, n: int = _MAX_LINES) -> str:
    lines = text.splitlines()
    if len(lines) <= n:
        return text
    return "\n".join(lines[:n]) + f"\n… (+{len(lines) - n} more lines)"
