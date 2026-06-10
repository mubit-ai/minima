"""
@mubit.agent decorator and mubit.session() context manager.

Provides scoped memory sessions with automatic context injection,
trace capture, and reflection — inspired by Agent Lightning's
@rollout decorator and tracer.lifespan() pattern.
"""

import functools
import inspect
import logging
import uuid
from contextlib import contextmanager, asynccontextmanager
from typing import Any, Callable, Optional, TypeVar

from mubit._context import get_context
from mubit._session import SessionContext

logger = logging.getLogger("mubit")

F = TypeVar("F", bound=Callable[..., Any])


def agent(
    agent_id: str,
    *,
    auto_reflect: bool = True,
    auto_inject: bool = True,
) -> Callable[[F], F]:
    """Decorator for agent functions with automatic memory management.

    Creates a child session scope for each invocation. Memory context is
    injected before LLM calls, traces are captured, and reflection fires
    on function exit.

    Usage::

        @mubit.agent("planner")
        def plan(task):
            return openai_client.chat.completions.create(...)

        @mubit.agent("researcher", auto_reflect=False)
        async def research(query):
            return await async_client.chat.completions.create(...)

    Args:
        agent_id: Identifier for this agent.
        auto_reflect: Trigger reflection when the function exits.
        auto_inject: Inject memory context before LLM calls.
    """

    def decorator(fn: F) -> F:
        is_async = inspect.iscoroutinefunction(fn)

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            parent = SessionContext.current()
            if parent is None:
                raise RuntimeError(
                    "mubit.init() must be called before using @mubit.agent"
                )

            child = parent.child(
                agent_id=agent_id,
                session_id=f"sess-{uuid.uuid4()}",
            )
            token = child.activate()

            # If learn module is active, create a scoped run
            ctx = get_context()
            learn_rm = None
            if ctx and ctx.auto_learn and ctx.run_manager:
                try:
                    import mubit.learn as learn_mod
                    learn_rm = learn_mod.start_run(
                        agent_id=agent_id,
                        session_id=child.session_id,
                        auto_reflect=auto_reflect,
                    )
                except Exception as e:
                    logger.warning(
                        "mubit.learn start_run failed for agent %r: %s", agent_id, e
                    )
                    if ctx and not getattr(ctx, "fail_open", True):
                        logger.error(
                            "mubit.learn fail_open is False but start_run failed; "
                            "scoped reflection disabled for agent %r",
                            agent_id,
                        )

            try:
                return fn(*args, **kwargs)
            finally:
                if learn_rm:
                    learn_rm.end()
                SessionContext.reset(token)

        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            parent = SessionContext.current()
            if parent is None:
                raise RuntimeError(
                    "mubit.init() must be called before using @mubit.agent"
                )

            child = parent.child(
                agent_id=agent_id,
                session_id=f"sess-{uuid.uuid4()}",
            )
            token = child.activate()

            ctx = get_context()
            learn_rm = None
            if ctx and ctx.auto_learn and ctx.run_manager:
                try:
                    import mubit.learn as learn_mod
                    learn_rm = learn_mod.start_run(
                        agent_id=agent_id,
                        session_id=child.session_id,
                        auto_reflect=auto_reflect,
                    )
                except Exception as e:
                    logger.warning(
                        "mubit.learn start_run failed for agent %r: %s", agent_id, e
                    )
                    if ctx and not getattr(ctx, "fail_open", True):
                        logger.error(
                            "mubit.learn fail_open is False but start_run failed; "
                            "scoped reflection disabled for agent %r",
                            agent_id,
                        )

            try:
                return await fn(*args, **kwargs)
            finally:
                if learn_rm:
                    learn_rm.end()
                SessionContext.reset(token)

        return async_wrapper if is_async else sync_wrapper  # type: ignore

    return decorator


@contextmanager
def session(agent_id: str, *, session_id: Optional[str] = None, auto_reflect: bool = True):
    """Context manager for a scoped memory session.

    Usage::

        with mubit.session("planning-agent") as s:
            # memory capture + injection active in this scope
            response = openai_client.chat.completions.create(...)

        # reflection fires automatically on exit

    Args:
        agent_id: Identifier for this agent scope.
        session_id: Override session ID (auto-generated if None).
        auto_reflect: Trigger reflection when the scope exits.

    Yields:
        The child SessionContext.
    """
    parent = SessionContext.current()
    if parent is None:
        raise RuntimeError(
            "mubit.init() must be called before using mubit.session()"
        )

    child = parent.child(
        agent_id=agent_id,
        session_id=session_id or f"sess-{uuid.uuid4()}",
    )
    token = child.activate()

    ctx = get_context()
    learn_rm = None
    if ctx and ctx.auto_learn and ctx.run_manager:
        try:
            import mubit.learn as learn_mod
            learn_rm = learn_mod.start_run(
                agent_id=agent_id,
                session_id=child.session_id,
                auto_reflect=auto_reflect,
            )
        except Exception as e:
            logger.warning(
                "mubit.learn start_run failed for agent %r: %s", agent_id, e
            )
            if ctx and not getattr(ctx, "fail_open", True):
                logger.error(
                    "mubit.learn fail_open is False but start_run failed; "
                    "scoped reflection disabled for agent %r",
                    agent_id,
                )

    try:
        yield child
    finally:
        if learn_rm:
            learn_rm.end()
        SessionContext.reset(token)


@asynccontextmanager
async def async_session(agent_id: str, *, session_id: Optional[str] = None, auto_reflect: bool = True):
    """Async context manager for a scoped memory session.

    Usage::

        async with mubit.async_session("planning-agent") as s:
            response = await async_client.chat.completions.create(...)

    Args:
        agent_id: Identifier for this agent scope.
        session_id: Override session ID.
        auto_reflect: Trigger reflection on exit.

    Yields:
        The child SessionContext.
    """
    parent = SessionContext.current()
    if parent is None:
        raise RuntimeError(
            "mubit.init() must be called before using mubit.async_session()"
        )

    child = parent.child(
        agent_id=agent_id,
        session_id=session_id or f"sess-{uuid.uuid4()}",
    )
    token = child.activate()

    ctx = get_context()
    learn_rm = None
    if ctx and ctx.auto_learn and ctx.run_manager:
        try:
            import mubit.learn as learn_mod
            learn_rm = learn_mod.start_run(
                agent_id=agent_id,
                session_id=child.session_id,
                auto_reflect=auto_reflect,
            )
        except Exception as e:
            logger.warning(
                "mubit.learn start_run failed for agent %r: %s", agent_id, e
            )
            if ctx and not getattr(ctx, "fail_open", True):
                logger.error(
                    "mubit.learn fail_open is False but start_run failed; "
                    "scoped reflection disabled for agent %r",
                    agent_id,
                )

    try:
        yield child
    finally:
        if learn_rm:
            learn_rm.end()
        SessionContext.reset(token)
