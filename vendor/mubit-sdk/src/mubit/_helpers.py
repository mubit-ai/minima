"""
Module-level stateless helper functions.

These read the active SessionContext from contextvars and delegate
to the Client, providing the Agent Lightning-inspired "emit_*" style API.
"""

import functools
import json
import logging
from typing import Any, Dict, List, Optional

from mubit._context import get_context, require_context
from mubit._session import SessionContext

logger = logging.getLogger("mubit")


def _fail_open_guard(default_return=None):
    """Decorator: swallow exceptions when MubitContext.fail_open is True."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception as e:
                ctx = get_context()
                if ctx and getattr(ctx, "fail_open", True):
                    logger.debug("mubit.%s failed (fail_open): %s", fn.__name__, e)
                    return default_return
                raise
        return wrapper
    return decorator


@_fail_open_guard(default_return=None)
def remember(
    content: str,
    *,
    intent: str = "",
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """Store something in memory. Uses implicit session context.

    Args:
        content: The text to remember.
        intent: Intent tag (e.g., "lesson", "fact", "preference", "observation").
        session_id: Override the session ID (default: from active session).
        agent_id: Override the agent ID (default: from active session).
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    aid = agent_id or (session.agent_id if session else None)

    return ctx.client.remember(
        session_id=sid,
        content=content,
        intent=intent,
        agent_id=aid,
        **kwargs,
    )


@_fail_open_guard(default_return={})
def recall(
    query: str,
    *,
    session_id: Optional[str] = None,
    limit: int = 5,
    entry_types: Optional[List[str]] = None,
    **kwargs: Any,
) -> Any:
    """Query memory for relevant information.

    Args:
        query: The search query.
        session_id: Override the session ID.
        limit: Max results.
        entry_types: Filter by entry types.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)

    return ctx.client.recall(
        session_id=sid,
        query=query,
        limit=limit,
        entry_types=entry_types,
        **kwargs,
    )


@_fail_open_guard(default_return={})
def context(
    query: str,
    *,
    session_id: Optional[str] = None,
    max_token_budget: int = 2048,
    entry_types: Optional[List[str]] = None,
    sections: Optional[List[str]] = None,
    **kwargs: Any,
) -> Any:
    """Get a token-budgeted context block for LLM injection.

    Args:
        query: The query to retrieve context for.
        session_id: Override the session ID.
        max_token_budget: Max tokens in the context block.
        entry_types: Filter by entry types.
        sections: Context sections to include.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)

    return ctx.client.context(
        session_id=sid,
        query=query,
        max_token_budget=max_token_budget,
        entry_types=entry_types,
        sections=sections,
        **kwargs,
    )


@_fail_open_guard(default_return=None)
def forget(
    content_id: str,
    *,
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """Remove an item from memory.

    Args:
        content_id: The ID of the content to forget.
        session_id: Override the session ID.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)

    return ctx.client.forget(
        lesson_id=content_id,
        session_id=sid,
        **kwargs,
    )


@_fail_open_guard(default_return=None)
def checkpoint(
    *,
    label: str = "",
    context_snapshot: str = "",
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """Create a durable checkpoint.

    Args:
        label: Human-readable checkpoint label.
        context_snapshot: Optional context snapshot text.
        session_id: Override the session ID.
        agent_id: Override the agent ID.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    aid = agent_id or (session.agent_id if session else None)

    return ctx.client.checkpoint(
        session_id=sid,
        label=label,
        context_snapshot=context_snapshot,
        agent_id=aid,
        **kwargs,
    )


@_fail_open_guard(default_return=None)
def reflect(
    *,
    session_id: Optional[str] = None,
    include_linked_runs: bool = False,
    **kwargs: Any,
) -> Any:
    """Trigger lesson extraction from recent activity.

    Args:
        session_id: Override the session ID.
        include_linked_runs: Include evidence from linked runs.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)

    return ctx.client.reflect(
        session_id=sid,
        include_linked_runs=include_linked_runs,
        **kwargs,
    )


@_fail_open_guard(default_return=None)
def outcome(
    score: float,
    *,
    outcome_label: str = "",
    reference_id: str = "global",
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """Record a reinforcement signal (inspired by Agent Lightning's emit_reward).

    Args:
        score: Numeric reward/outcome signal (e.g., 0.0 to 1.0).
        outcome_label: Label like "success", "failure", "partial".
        reference_id: ID of the lesson or action this outcome is for (default: "global").
        session_id: Override the session ID.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)

    return ctx.client.record_outcome(
        session_id=sid,
        reference_id=reference_id,
        outcome=outcome_label,
        signal=score,
        **kwargs,
    )


@_fail_open_guard(default_return=None)
def learned(
    content: str,
    *,
    importance: str = "medium",
    session_id: Optional[str] = None,
    verified_in_production: bool = False,
    env_tags: Optional[List[str]] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """One-liner convenience for storing a production-tested lesson.

    Equivalent to ``remember(content, intent="lesson", lesson_type="success",
    lesson_scope="session", ...)``.  Pass ``verified_in_production=True`` when
    the pattern was confirmed in a live production environment.

    Args:
        content: The lesson text.
        importance: Importance level ("low", "medium", "high", "critical").
        verified_in_production: Whether this was verified in production.
        env_tags: Semantic environment tags, e.g. ["lang:python:3.12"].
        session_id: Override the session ID.
        agent_id: Override the agent ID.
    """
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    aid = agent_id or (session.agent_id if session else None)

    return ctx.client.learned(
        content,
        importance=importance,
        session_id=sid,
        verified_in_production=verified_in_production,
        env_tags=env_tags,
        agent_id=aid or "sdk-client",
        **kwargs,
    )


# ── Prompt Lifecycle Management ──────────────────────────────────────


@_fail_open_guard(default_return=None)
def set_prompt(
    content: str,
    *,
    agent_id: Optional[str] = None,
    activate: bool = True,
    **kwargs: Any,
) -> Any:
    """Store a system prompt for the current agent (creates a new version).

    Args:
        content: The system prompt text.
        agent_id: Override the agent ID (default: from active session).
        activate: Whether to immediately activate this version (default: True).
    """
    ctx = require_context()
    session = SessionContext.current()
    aid = agent_id or (session.agent_id if session else ctx.learn_config.agent_id)

    result = ctx.client.set_prompt({
        "agent_id": aid,
        "content": content,
        "activate": activate,
    })

    # Bust the prompt cache so next get_prompt() fetches the new version
    if ctx.prompt_cache:
        ctx.prompt_cache.invalidate(aid)

    return result


@_fail_open_guard(default_return="")
def get_prompt(
    *,
    agent_id: Optional[str] = None,
    version_id: Optional[str] = None,
    **kwargs: Any,
) -> str:
    """Get the active system prompt for the current agent.

    Returns the prompt content string. Returns empty string if no prompt is set.
    Results are cached (60s TTL) to avoid network round-trips on every LLM call.

    Args:
        agent_id: Override the agent ID (default: from active session).
        version_id: Get a specific version instead of the active one.
    """
    ctx = require_context()
    session = SessionContext.current()
    aid = agent_id or (session.agent_id if session else ctx.learn_config.agent_id)
    vid = version_id or ""

    # Check prompt cache first
    if ctx.prompt_cache:
        cached = ctx.prompt_cache.get(aid, vid)
        if cached is not None:
            return cached

    resp = ctx.client.get_prompt({
        "agent_id": aid,
        "version_id": vid,
    })
    version = resp.get("version") if isinstance(resp, dict) else None
    content = version.get("content", "") if isinstance(version, dict) else ""

    # Cache the result
    if ctx.prompt_cache and content:
        ctx.prompt_cache.set(aid, vid, content)

    return content


# ── Skill Management ────────────────────────────────────────────────


def _format_skill(skill: Dict[str, Any], fmt: str) -> Dict[str, Any]:
    """Convert a skill definition to LLM framework tool format."""
    schema_str = skill.get("parameters_schema") or skill.get("parametersSchema") or ""
    try:
        schema = json.loads(schema_str) if schema_str else {}
    except (json.JSONDecodeError, TypeError):
        schema = {}
    name = skill.get("name", "")
    desc = skill.get("description", "")

    if fmt == "anthropic":
        return {"name": name, "description": desc, "input_schema": schema}
    if fmt == "gemini":
        return {"name": name, "description": desc, "parameters": schema}
    if fmt == "raw":
        return skill
    # Default: OpenAI
    return {
        "type": "function",
        "function": {"name": name, "description": desc, "parameters": schema},
    }


@_fail_open_guard(default_return=[])
def get_skills(
    *,
    project_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    format: str = "openai",
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    """Get active skill/tool definitions for the current agent.

    Returns tool definitions formatted for the requested LLM framework, ready to
    pass to `llm.bind_tools()` / `tools=` parameter of OpenAI/Anthropic/Gemini.

    Args:
        project_id: Project ID (default: from active session).
        agent_id: Agent ID filter (default: from active session; empty = shared + agent-specific).
        format: Output format — "openai" (default), "anthropic", "gemini", or "raw".
    """
    ctx = require_context()
    session = SessionContext.current()
    pid = project_id or (getattr(session, "project_id", "") if session else "")
    aid = agent_id or (session.agent_id if session else "")

    if not pid:
        return []

    resp = ctx.client.list_skills({"project_id": pid, "agent_id": aid or ""})
    skills = resp.get("skills", []) if isinstance(resp, dict) else []
    return [_format_skill(s, format) for s in skills]


@_fail_open_guard(default_return=None)
def set_skill(
    name: str,
    description: str,
    *,
    parameters_schema: Optional[Any] = None,
    instructions: str = "",
    skill_type: str = "tool",
    project_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """Create a skill definition in the current project.

    Args:
        name: Skill name (e.g., "search_knowledge_base").
        description: What the skill does + when to use it.
        parameters_schema: JSON Schema dict or string. Defaults to empty object.
        instructions: Markdown instructions (for playbook type).
        skill_type: "tool" (function definition) or "playbook".
        project_id: Project ID (default: from active session).
        agent_id: Target agent ID (empty/None = project-shared).
    """
    ctx = require_context()
    session = SessionContext.current()
    pid = project_id or (getattr(session, "project_id", "") if session else "")
    if not pid:
        raise ValueError("project_id is required (no active session with project_id)")

    if isinstance(parameters_schema, dict):
        schema_str = json.dumps(parameters_schema)
    elif isinstance(parameters_schema, str):
        schema_str = parameters_schema
    else:
        schema_str = ""

    return ctx.client.create_skill({
        "project_id": pid,
        "agent_id": agent_id or "",
        "name": name,
        "description": description,
        "parameters_schema": schema_str,
        "instructions": instructions,
        "skill_type": skill_type,
    })
