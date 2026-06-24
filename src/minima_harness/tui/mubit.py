from __future__ import annotations

import logging
import os
from dataclasses import dataclass
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
    # `or` (not get-with-default) so a blank MUBIT_ENDPOINT="" — e.g. a stray empty line in a
    # copied .env — falls back to the hosted default instead of passing "" to mubit.init().
    endpoint = os.environ.get("MUBIT_ENDPOINT") or _DEFAULT_ENDPOINT
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


def optimize_prompt() -> dict[str, Any] | None:
    """Ask Mubit to optimize this agent's system prompt from accumulated lessons + outcomes.

    Returns the raw response ``{success, activated, candidate, confidence,
    optimization_summary}`` (the candidate is a non-activated suggestion), or None on any
    failure. Verified live: ``activated`` is False, so this never changes the active prompt.
    """
    if not _initialized:
        return None
    try:
        from mubit._helpers import require_context

        return require_context().client.optimize_prompt({"agent_id": _AGENT_ID})
    except Exception:  # noqa: BLE001 - Mubit must never block the TUI
        _log.warning("mubit_optimize_prompt_failed", exc_info=True)
        return None


@dataclass(frozen=True, slots=True)
class Optimization:
    """A proposed system-prompt optimization, for the /optimize preview."""

    new_prompt: str
    current_tokens: int
    new_tokens: int
    est_savings: int  # current - new; negative means the prompt grew (quality over size)
    rationale: str
    source: str  # "mubit" | "local"


def _local_optimization(cwd: Path) -> Optimization | None:
    """Fallback when Mubit is unreachable: conservatively drop exact-duplicate lines from the
    current Mubit prompt. Suggestion only; returns None when there's nothing safe to remove."""
    current = get_prompt().strip()
    if not current:
        return None
    lines = current.splitlines()
    seen: set[str] = set()
    deduped: list[str] = []
    for ln in lines:
        key = ln.strip()
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        deduped.append(ln)
    new_prompt = "\n".join(deduped)
    savings = estimate_tokens(current) - estimate_tokens(new_prompt)
    if savings <= 0:
        return None
    removed = len(lines) - len(deduped)
    return Optimization(
        new_prompt=new_prompt,
        current_tokens=estimate_tokens(current),
        new_tokens=estimate_tokens(new_prompt),
        est_savings=savings,
        rationale=f"removed {removed} duplicate line(s)",
        source="local",
    )


def propose_prompt_optimization(cwd: Path, n_sessions: int = 10) -> Optimization | None:
    """Propose a system-prompt optimization: Mubit's lesson-grounded candidate (Path A) when
    available, else a local dedup (Path B). Never auto-applies — the caller previews + confirms."""
    current = get_prompt()
    resp = optimize_prompt()
    if isinstance(resp, dict) and resp.get("success"):
        cand = resp.get("candidate")
        new_prompt = cand.get("content", "") if isinstance(cand, dict) else ""
        if new_prompt.strip():
            summary = (resp.get("optimization_summary") or "").strip()
            return Optimization(
                new_prompt=new_prompt.strip(),
                current_tokens=estimate_tokens(current),
                new_tokens=estimate_tokens(new_prompt),
                est_savings=estimate_tokens(current) - estimate_tokens(new_prompt),
                rationale=summary or "Mubit consolidated lessons + outcomes into the prompt.",
                source="mubit",
            )
    return _local_optimization(cwd)


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


@dataclass(frozen=True, slots=True)
class PromptLayer:
    """One layer of the assembled system prompt, for transparent display + control.

    ``header`` is the section prefix used in the joined prompt (empty for the leading
    layer); ``rendered`` reproduces exactly how the layer appears in ``effective_prompt``.
    ``editable_target`` is ``"project"`` (→ Mubit), ``"session"`` (→ override), or ``None``.
    """

    name: str
    text: str
    header: str = ""
    source: str = ""
    editable_target: str | None = None

    @property
    def rendered(self) -> str:
        return f"{self.header}\n{self.text}" if self.header else self.text

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.rendered)


def prompt_layers(cwd: Path, session_override: str = "") -> list[PromptLayer]:
    """The ordered layers that compose the system prompt. Single source of truth —
    ``effective_prompt`` is a thin join over this, so the inspector can never drift."""
    from minima_harness.tui.context import build_system_prompt_parts, load_agents_md

    layers: list[PromptLayer] = []
    mubit_prompt = get_prompt().strip()
    if mubit_prompt:
        layers.append(
            PromptLayer("system prompt", mubit_prompt, source="mubit", editable_target="project")
        )
        agents = load_agents_md(cwd)
        if agents:
            layers.append(
                PromptLayer("project context", agents, "# Project context", "agents.md")
            )
    else:
        for name, text in build_system_prompt_parts(cwd):
            if name == "base":
                layers.append(PromptLayer("base prompt", text, source="local"))
            else:  # agents.md
                layers.append(
                    PromptLayer("project context", text, "# Project context", "agents.md")
                )
    override = session_override.strip()
    if override:
        layers.append(
            PromptLayer(
                "session override", override, "# Session override", "session", "session"
            )
        )
    lessons = learned().strip()
    if lessons:
        layers.append(PromptLayer("lessons (Mubit)", lessons, "# Lessons (Mubit)", "mubit"))
    return layers


def effective_prompt(cwd: Path, session_override: str = "") -> str:
    """The system prompt sent to the model: the rendered join of :func:`prompt_layers`."""
    return "\n\n".join(layer.rendered for layer in prompt_layers(cwd, session_override))


def token_breakdown(cwd: Path, messages: list) -> dict[str, int]:
    """Approximate token counts per section of the context that goes to the model."""
    system = effective_prompt(cwd)
    history = "\n".join(getattr(m, "text", "") for m in messages)
    return {
        "system": estimate_tokens(system),
        "history": estimate_tokens(history),
        "total": estimate_tokens(system) + estimate_tokens(history),
    }


def layer_token_breakdown(
    cwd: Path, messages: list, session_override: str = ""
) -> dict[str, Any]:
    """Per-layer token counts + history + total, for the layered prompt inspector."""
    layers = prompt_layers(cwd, session_override)
    history = estimate_tokens("\n".join(getattr(m, "text", "") for m in messages))
    layer_tokens = [(layer.name, layer.tokens) for layer in layers]
    system = sum(t for _, t in layer_tokens)
    return {"layers": layer_tokens, "system": system, "history": history, "total": system + history}
