"""
mubit.init() — single entry point for SDK initialization.

Merges the functionality of Client(), learn.init(), and auto.instrument()
into one call. Creates a server-side session and sets up implicit context.
"""

import atexit
import logging
import os
import uuid
from typing import Optional

from mubit._context import MubitContext, set_context, get_context
from mubit._prompt_cache import PromptCache
from mubit._session import SessionContext

logger = logging.getLogger("mubit")


def init(
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    agent_id: Optional[str] = None,
    user_id: str = "",
    project_id: Optional[str] = None,
    *,
    auto_instrument: bool = True,
    auto_learn: bool = True,
    # Learn-specific config (forwarded to learn.init if auto_learn=True)
    inject_lessons: bool = True,
    injection_position: str = "system",
    max_token_budget: int = 2048,
    entry_types: Optional[list] = None,
    context_sections: Optional[list] = None,
    auto_reflect: bool = True,
    reflect_after_n_calls: Optional[int] = None,
    cache_ttl_seconds: float = 30.0,
    fail_open: bool = True,
) -> MubitContext:
    """Initialize the Mubit SDK — one call to enable agentic memory.

    After calling init(), all supported LLM library calls (OpenAI, Anthropic,
    LiteLLM, Google GenAI) are automatically enriched with memory context
    and their outputs are captured for learning.

    Args:
        api_key: MuBit API key. Falls back to MUBIT_API_KEY env var.
        endpoint: MuBit endpoint. Falls back to MUBIT_ENDPOINT env var.
        agent_id: Default agent ID. Falls back to "default".
        user_id: Default user ID for scoping.
        project_id: Optional project ID for project-scoped agent management.
        auto_instrument: Monkey-patch LLM libraries for auto-capture.
        auto_learn: Enable lesson injection + extraction (requires auto_instrument).
        inject_lessons: Inject lessons before LLM calls (requires auto_learn).
        injection_position: Where to inject ("system", "prepend", "last_system").
        max_token_budget: Token budget for context retrieval.
        entry_types: Memory entry types to retrieve.
        context_sections: Context sections to include.
        auto_reflect: Trigger reflection when session ends.
        reflect_after_n_calls: Trigger reflection every N calls.
        cache_ttl_seconds: Lesson cache TTL.
        fail_open: Proceed without lessons on retrieval failure.

    Returns:
        MubitContext instance (also stored as module singleton).
    """
    resolved_api_key = api_key or os.environ.get("MUBIT_API_KEY", "")
    resolved_endpoint = endpoint or os.environ.get("MUBIT_ENDPOINT", "")
    resolved_agent_id = agent_id or "default"
    resolved_project_id = project_id or os.environ.get("MUBIT_PROJECT_ID", "")

    # Create the Client
    from mubit.client import Client

    transport = "auto"
    if resolved_endpoint and resolved_endpoint.startswith("http"):
        transport = "http"

    client = Client(
        endpoint=resolved_endpoint or None,
        api_key=resolved_api_key or None,
        transport=transport,
    )

    # Try to create a server-side session
    server_session_id = None
    server_run_id = None
    try:
        session_payload = {
            "agent_id": resolved_agent_id,
            "auto_register_agent": True,
        }
        if resolved_project_id:
            session_payload["project_id"] = resolved_project_id
        resp = client.create_session(session_payload)
        if isinstance(resp, dict):
            session_data = resp.get("session", resp)
            server_session_id = session_data.get("sessionId") or session_data.get("session_id")
            server_run_id = session_data.get("runId") or session_data.get("run_id")
    except Exception as e:
        logger.debug("Server session creation failed (continuing with local ID): %s", e)

    # Fallback to local IDs if server session creation failed
    session_id = server_session_id or f"sess-{uuid.uuid4()}"
    run_id = server_run_id or f"run-{uuid.uuid4()}"

    learn_config = None
    learn_client = None
    lesson_cache = None
    run_manager = None

    if auto_learn and auto_instrument:
        # Use learn.init() which handles both learning and instrumentation
        import mubit.learn as learn_mod
        run_manager = learn_mod.init(
            api_key=resolved_api_key,
            endpoint=resolved_endpoint,
            agent_id=resolved_agent_id,
            user_id=user_id,
            session_id=session_id,
            inject_lessons=inject_lessons,
            injection_position=injection_position,
            max_token_budget=max_token_budget,
            entry_types=entry_types,
            context_sections=context_sections,
            auto_reflect=auto_reflect,
            reflect_after_n_calls=reflect_after_n_calls,
            cache_ttl_seconds=cache_ttl_seconds,
            fail_open=fail_open,
        )
        learn_config = learn_mod._active_config
        learn_client = learn_mod._learn_client
        lesson_cache = learn_mod._lesson_cache
    elif auto_instrument:
        # Auto-capture only (no learning/injection)
        from mubit.auto._instrument import instrument
        instrument(
            session_id=session_id,
            agent_id=resolved_agent_id,
            user_id=user_id,
            mubit_api_key=resolved_api_key,
            mubit_endpoint=resolved_endpoint,
        )

    ctx = MubitContext(
        client=client,
        learn_config=learn_config,
        learn_client=learn_client,
        lesson_cache=lesson_cache,
        run_manager=run_manager,
        prompt_cache=PromptCache(ttl_seconds=60.0),
        auto_instrument=auto_instrument,
        auto_learn=auto_learn,
        fail_open=fail_open,
    )
    ctx._server_session_id = server_session_id
    ctx._server_run_id = server_run_id

    set_context(ctx)

    # Set up the root session context in contextvars
    root_session = SessionContext(
        session_id=session_id,
        agent_id=resolved_agent_id,
        run_id=run_id,
        user_id=user_id,
        project_id=resolved_project_id,
    )
    root_session.activate()

    # Register cleanup
    atexit.register(_cleanup)

    return ctx


def _cleanup() -> None:
    """Atexit handler: close the server session if active."""
    ctx = get_context()
    if ctx is None:
        return

    session = SessionContext.current()
    if session is None:
        return

    # Try to close the server session
    if ctx._server_session_id:
        try:
            ctx.client.close_session({
                "session_id": ctx._server_session_id,
                "reflect_on_close": True,
            })
        except Exception:
            pass
