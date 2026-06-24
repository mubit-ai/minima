from __future__ import annotations

from pathlib import Path

from minima_harness.session.format import EntryType

CONTEXT_FILES = ("AGENTS.md", "CLAUDE.md")
GLOBAL_DIR = Path.home() / ".minima-harness"

BASE_SYSTEM = (
    "You are an interactive coding agent running in the user's terminal. Use the provided "
    "tools (read, write, edit, bash, grep, find, ls) to explore and modify the codebase. "
    "Be concise and direct; explain only when asked."
)

SUMMARY_SYSTEM = (
    "You compact a coding-agent conversation. Summarize the work done so far: key decisions, "
    "file paths touched, current state, and open questions. Be concise. Output only the summary."
)
SUMMARY_USER = "Summarize the conversation above for context continuity."


def _read(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
        return text.strip() or None
    except OSError:  # noqa: BLE001
        return None


def load_agents_md(cwd: Path) -> str:
    """Concatenate AGENTS.md/CLAUDE.md from the global dir + cwd's parent chain (root → cwd)."""
    chunks: list[str] = []
    for name in CONTEXT_FILES:
        g = _read(GLOBAL_DIR / name)
        if g:
            chunks.append(f"# ({name}, global)\n{g}")

    parts: list[Path] = []
    node = cwd.resolve()
    while True:
        parts.append(node)
        if node.parent == node:
            break
        node = node.parent
    for d in reversed(parts):  # rootward first, cwd last
        for name in CONTEXT_FILES:
            t = _read(d / name)
            if t:
                chunks.append(f"# ({name}, {d.name})\n{t}")
    return "\n\n".join(chunks)


def build_system_prompt_parts(cwd: Path) -> list[tuple[str, str]]:
    """The local system prompt as labeled parts: always ``("base", ...)``, plus
    ``("agents.md", ...)`` when project context exists.

    ``build_system_prompt`` joins these into one string; splitting them lets the prompt
    inspector show the base prompt and project context (AGENTS.md/CLAUDE.md) as distinct
    layers without duplicating the assembly logic.
    """
    replace = _read(cwd / "SYSTEM.md") or _read(GLOBAL_DIR / "SYSTEM.md")
    append = _read(cwd / "APPEND_SYSTEM.md") or _read(GLOBAL_DIR / "APPEND_SYSTEM.md")
    base = replace if replace else BASE_SYSTEM
    if append:
        base = f"{base}\n\n{append}"
    parts: list[tuple[str, str]] = [("base", base)]
    agents = load_agents_md(cwd)
    if agents:
        parts.append(("agents.md", agents))
    return parts


def build_system_prompt(cwd: Path) -> str:
    """Base prompt + AGENTS.md context + SYSTEM.md (replace) / APPEND_SYSTEM.md (append)."""
    parts = build_system_prompt_parts(cwd)
    prompt = parts[0][1]
    for _name, text in parts[1:]:  # only "agents.md" follows base today
        prompt = f"{prompt}\n\n# Project context\n{text}"
    return prompt


def get_session_override(store) -> str:
    """Read the most recent session-level system-prompt override (a SYSTEM entry)."""
    for entry in reversed(store.entries):
        if entry.type == EntryType.SYSTEM and "override" in entry.payload:
            return entry.payload.get("override", "")
    return ""


def set_session_override(store, text: str) -> None:
    """Persist a session-level system-prompt override."""
    store.append(EntryType.SYSTEM, {"override": text})
