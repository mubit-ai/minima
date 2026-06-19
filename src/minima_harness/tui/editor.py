from __future__ import annotations

import asyncio
from pathlib import Path


def parse_submission(text: str) -> dict:
    """Classify raw editor text into a command / bash / message submission."""
    t = text.strip()
    if t.startswith("/"):
        name, _, args = t[1:].partition(" ")
        return {"kind": "command", "name": name, "args": args.strip()}
    if t.startswith("!!"):
        return {"kind": "bash", "command": t[2:], "feed": False}
    if t.startswith("!"):
        return {"kind": "bash", "command": t[1:], "feed": True}
    return {"kind": "message", "text": expand_at_files(t)}


def expand_at_files(text: str) -> str:
    """Inline-expand ``@path`` tokens that point at real files into fenced content."""
    out: list[str] = []
    for token in text.split():
        if token.startswith("@") and len(token) > 1:
            p = Path(token[1:]).expanduser()
            if p.is_file():
                try:
                    out.append(f'<file path="{p}">\n{p.read_text(encoding="utf-8")}\n</file>')
                    continue
                except OSError:  # noqa: BLE001
                    pass
        out.append(token)
    return " ".join(out)


async def run_bash(command: str) -> str:
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    return out.decode("utf-8", errors="replace")
