"""
Async counterparts for module-level helper functions.

Usage: import mubit.aio; prompt = await mubit.aio.get_prompt()

Uses asyncio.to_thread() to offload blocking SDK calls, freeing the
event loop in async applications (FastAPI, etc.).
"""

import asyncio
import functools
import json
import logging
from typing import Any, Dict, List, Optional

from mubit._context import get_context, require_context
from mubit._session import SessionContext

logger = logging.getLogger("mubit")


def _async_fail_open_guard(default_return=None):
    """Decorator: swallow exceptions when MubitContext.fail_open is True (async)."""
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except Exception as e:
                ctx = get_context()
                if ctx and getattr(ctx, "fail_open", True):
                    logger.debug("mubit.aio.%s failed (fail_open): %s", fn.__name__, e)
                    return default_return
                raise
        return wrapper
    return decorator


@_async_fail_open_guard(default_return=None)
async def remember(
    content: str,
    *,
    intent: str = "",
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    aid = agent_id or (session.agent_id if session else None)
    return await asyncio.to_thread(
        ctx.client.remember,
        session_id=sid, content=content, intent=intent, agent_id=aid,
        wait=False,
        **kwargs,
    )


@_async_fail_open_guard(default_return={})
async def recall(
    query: str,
    *,
    session_id: Optional[str] = None,
    limit: int = 5,
    entry_types: Optional[List[str]] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    return await asyncio.to_thread(
        ctx.client.recall,
        session_id=sid, query=query, limit=limit, entry_types=entry_types,
        **kwargs,
    )


@_async_fail_open_guard(default_return={})
async def context(
    query: str,
    *,
    session_id: Optional[str] = None,
    max_token_budget: int = 2048,
    entry_types: Optional[List[str]] = None,
    sections: Optional[List[str]] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    return await asyncio.to_thread(
        ctx.client.context,
        session_id=sid, query=query, max_token_budget=max_token_budget,
        entry_types=entry_types, sections=sections,
        **kwargs,
    )


@_async_fail_open_guard(default_return=None)
async def forget(
    content_id: str,
    *,
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    return await asyncio.to_thread(
        ctx.client.forget, lesson_id=content_id, session_id=sid, **kwargs,
    )


@_async_fail_open_guard(default_return=None)
async def checkpoint(
    *,
    label: str = "",
    context_snapshot: str = "",
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    aid = agent_id or (session.agent_id if session else None)
    return await asyncio.to_thread(
        ctx.client.checkpoint,
        session_id=sid, label=label, context_snapshot=context_snapshot, agent_id=aid,
        **kwargs,
    )


@_async_fail_open_guard(default_return=None)
async def reflect(
    *,
    session_id: Optional[str] = None,
    include_linked_runs: bool = False,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    return await asyncio.to_thread(
        ctx.client.reflect,
        session_id=sid, include_linked_runs=include_linked_runs, **kwargs,
    )


@_async_fail_open_guard(default_return=None)
async def outcome(
    score: float,
    *,
    outcome_label: str = "",
    reference_id: str = "global",
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    sid = session_id or (session.session_id if session else None)
    return await asyncio.to_thread(
        ctx.client.record_outcome,
        session_id=sid, reference_id=reference_id, outcome=outcome_label, signal=score,
        **kwargs,
    )


@_async_fail_open_guard(default_return=None)
async def set_prompt(
    content: str,
    *,
    agent_id: Optional[str] = None,
    activate: bool = True,
    **kwargs: Any,
) -> Any:
    ctx = require_context()
    session = SessionContext.current()
    aid = agent_id or (session.agent_id if session else ctx.learn_config.agent_id)
    result = await asyncio.to_thread(
        ctx.client.set_prompt,
        {"agent_id": aid, "content": content, "activate": activate},
    )
    if ctx.prompt_cache:
        ctx.prompt_cache.invalidate(aid)
    return result


@_async_fail_open_guard(default_return="")
async def get_prompt(
    *,
    agent_id: Optional[str] = None,
    version_id: Optional[str] = None,
    **kwargs: Any,
) -> str:
    ctx = require_context()
    session = SessionContext.current()
    aid = agent_id or (session.agent_id if session else ctx.learn_config.agent_id)
    vid = version_id or ""

    if ctx.prompt_cache:
        cached = ctx.prompt_cache.get(aid, vid)
        if cached is not None:
            return cached

    resp = await asyncio.to_thread(
        ctx.client.get_prompt,
        {"agent_id": aid, "version_id": vid},
    )
    version = resp.get("version") if isinstance(resp, dict) else None
    content = version.get("content", "") if isinstance(version, dict) else ""

    if ctx.prompt_cache and content:
        ctx.prompt_cache.set(aid, vid, content)

    return content


# ── Skill Management (async) ────────────────────────────────────────


def _format_skill(skill: Dict[str, Any], fmt: str) -> Dict[str, Any]:
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
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": schema}}


@_async_fail_open_guard(default_return=[])
async def get_skills(
    *,
    project_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    format: str = "openai",
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    ctx = require_context()
    session = SessionContext.current()
    pid = project_id or (getattr(session, "project_id", "") if session else "")
    aid = agent_id or (session.agent_id if session else "")
    if not pid:
        return []

    resp = await asyncio.to_thread(
        ctx.client.list_skills,
        {"project_id": pid, "agent_id": aid or ""},
    )
    skills = resp.get("skills", []) if isinstance(resp, dict) else []
    return [_format_skill(s, format) for s in skills]


@_async_fail_open_guard(default_return=None)
async def set_skill(
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
    ctx = require_context()
    session = SessionContext.current()
    pid = project_id or (getattr(session, "project_id", "") if session else "")
    if not pid:
        raise ValueError("project_id is required")

    if isinstance(parameters_schema, dict):
        schema_str = json.dumps(parameters_schema)
    elif isinstance(parameters_schema, str):
        schema_str = parameters_schema
    else:
        schema_str = ""

    return await asyncio.to_thread(
        ctx.client.create_skill,
        {
            "project_id": pid,
            "agent_id": agent_id or "",
            "name": name,
            "description": description,
            "parameters_schema": schema_str,
            "instructions": instructions,
            "skill_type": skill_type,
        },
    )
