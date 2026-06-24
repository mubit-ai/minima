from __future__ import annotations

from pathlib import Path

MAX_LINE = 2000


def truncate_line(line: str) -> str:
    if len(line) <= MAX_LINE:
        return line
    return line[:MAX_LINE] + " …(truncated)"


def read_lines(path: Path, *, offset: int, limit: int) -> tuple[str, int]:
    """Return (numbered_body, n_selected) for lines [offset, offset+limit)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    start = max(0, offset - 1)
    end = min(len(lines), start + limit)
    selected = lines[start:end]
    width = len(str(end if end else 1))
    body = "\n".join(
        f"{str(i).rjust(width)}: {truncate_line(line)}"
        for i, line in enumerate(selected, start=start + 1)
    )
    if end < len(lines):
        body += f"\n…({len(lines) - end} more lines; use a larger offset to continue)"
    return body, len(selected)


def write_text(path: Path, content: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return len(content.splitlines())
