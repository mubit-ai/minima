from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

_log = logging.getLogger("minima_harness.tui.mubit")

_DEFAULT_ENDPOINT = "https://api.mubit.ai"
_AGENT_ID = "minima-harness"
_initialized = False


def _slug(cwd: Path) -> str:
    from minima_harness.session import SessionManager

    return SessionManager().slug_for(cwd)


def init_mubit(cwd: Path) -> bool:
    """Initialize the Mubit SDK for this project (idempotent). Returns True if available."""
    global _initialized
    if _initialized:
        return True
    key = os.environ.get("MUBIT_API_KEY")
    if not key:
        _log.warning("mubit_no_api_key")
        return False
    endpoint = os.environ.get("MUBIT_ENDPOINT", _DEFAULT_ENDPOINT)
    try:
        import mubit

        mubit.init(
            api_key=key,
            endpoint=endpoint,
            agent_id=_AGENT_ID,
            project_id=_slug(cwd),
            auto_instrument=False,
            auto_learn=False,
            inject_lessons=True,
        )
        _initialized = True
        return True
    except Exception:  # noqa: BLE001 - Mubit must never block the TUI
        _log.warning("mubit_init_failed", exc_info=True)
        return False


def available() -> bool:
    return _initialized


def get_prompt() -> str:
    if not _initialized:
        return ""
    try:
        import mubit

        return mubit.get_prompt(agent_id=_AGENT_ID) or ""
    except Exception:  # noqa: BLE001
        _log.warning("mubit_get_prompt_failed", exc_info=True)
        return ""


def set_prompt(content: str) -> bool:
    try:
        import mubit

        mubit.set_prompt(content, agent_id=_AGENT_ID, activate=True)
        return True
    except Exception:  # noqa: BLE001
        _log.warning("mubit_set_prompt_failed", exc_info=True)
        return False


def get_skills(cwd: Path) -> list[dict[str, Any]]:
    if not _initialized:
        return []
    try:
        import mubit

        return mubit.get_skills(project_id=_slug(cwd)) or []
    except Exception:  # noqa: BLE001
        return []


def set_skill(cwd: Path, name: str, description: str, instructions: str = "") -> bool:
    try:
        import mubit

        mubit.set_skill(name, description, instructions=instructions, project_id=_slug(cwd))
        return True
    except Exception:  # noqa: BLE001
        _log.warning("mubit_set_skill_failed", exc_info=True)
        return False


def recall(query: str, session_id: str | None = None, limit: int = 5) -> list[Any]:
    if not _initialized:
        return []
    try:
        import mubit

        return mubit.recall(query, session_id=session_id, limit=limit) or []
    except Exception:  # noqa: BLE001
        return []


def learned() -> str:
    if not _initialized:
        return ""
    try:
        import mubit

        return mubit.learned() or ""
    except Exception:  # noqa: BLE001
        return ""


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def effective_prompt(cwd: Path, session_override: str = "") -> str:
    """The system prompt sent to the model: Mubit prompt (if set) or the local compose,
    plus local AGENTS.md context, a session override, and Mubit-injected lessons."""
    from minima_harness.tui.context import build_system_prompt, load_agents_md

    mubit_prompt = get_prompt()
    parts: list[str] = []
    if mubit_prompt.strip():
        parts.append(mubit_prompt.strip())
        agents = load_agents_md(cwd)
        if agents:
            parts.append(f"# Project context\n{agents}")
    else:
        parts.append(build_system_prompt(cwd))
    if session_override.strip():
        parts.append(f"# Session override\n{session_override.strip()}")
    lessons = learned()
    if lessons.strip():
        parts.append(f"# Lessons (Mubit)\n{lessons.strip()}")
    return "\n\n".join(parts)


def token_breakdown(cwd: Path, messages: list) -> dict[str, int]:
    """Approximate token counts per section of the context that goes to the model."""
    system = effective_prompt(cwd)
    history = "\n".join(getattr(m, "text", "") for m in messages)
    return {
        "system": estimate_tokens(system),
        "history": estimate_tokens(history),
        "total": estimate_tokens(system) + estimate_tokens(history),
    }
