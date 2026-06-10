"""
MuBit Learn Anthropic Wrapper.

Extends the existing auto-capture Anthropic wrapper with pre-call lesson
retrieval and injection into the Anthropic `system` parameter.
"""

import logging
from typing import Any, Optional

from mubit.auto._anthropic import wrap_anthropic
from mubit.auto._context import get_current_span, is_async_callable, is_async_client
from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig
from mubit.learn._extraction import extract_structured_items
from mubit.learn._injection import extract_query, inject_context_anthropic
from mubit.learn._lesson_cache import LessonCache
from mubit.learn._run_manager import RunManager

logger = logging.getLogger("mubit.learn")


def _anthropic_response_text(response: Any) -> str:
    """Extract assistant text from an Anthropic message response."""
    try:
        content = getattr(response, "content", None)
        if isinstance(content, list):
            return "".join(
                getattr(b, "text", "") or ""
                for b in content
                if getattr(b, "type", "") == "text"
            )
    except Exception:
        pass
    return ""


def wrap_anthropic_learn(
    client: Any,
    *,
    learn_config: LearnConfig,
    lesson_cache: LessonCache,
    learn_client: LearnClient,
    run_manager: RunManager,
    session_id: str = "",
    agent_id: str = "auto",
    user_id: str = "",
    capture: str = "all",
    min_length: int = 0,
    mubit_api_key: Optional[str] = None,
    mubit_endpoint: Optional[str] = None,
    is_async: Optional[bool] = None,
) -> Any:
    """Wrap an Anthropic client with learn (inject + ingest) capabilities."""
    if not hasattr(client, "messages") or not hasattr(client.messages, "create"):
        return client

    if getattr(client, "_mubit_learn_wrapped", None) is True:
        return client

    # Apply auto-capture wrapping first
    wrap_anthropic(
        client,
        session_id=session_id,
        agent_id=agent_id,
        user_id=user_id,
        capture=capture,
        min_length=min_length,
        mubit_api_key=mubit_api_key,
        mubit_endpoint=mubit_endpoint,
        is_async=is_async,
    )

    auto_create = client.messages.create
    if is_async is None:
        is_async = is_async_client(client) or is_async_callable(auto_create)

    def _record_recalled(ids):
        run_manager.set_recalled_ids(ids)
        span = get_current_span()
        if span is not None:
            span.recalled_entry_ids = list(ids or [])

    def _enrich_kwargs(kwargs):
        """Inject context into the Anthropic system parameter (one recall)."""
        if not learn_config.inject_lessons:
            return kwargs

        messages = kwargs.get("messages", [])
        query = extract_query(messages)
        if not query:
            return kwargs

        sid = run_manager.session_id
        context_block = lesson_cache.get(sid, query)
        if context_block is None:
            try:
                context_block, ids = learn_client.get_context_with_ids(
                    session_id=sid,
                    query=query,
                    max_token_budget=learn_config.max_token_budget,
                    entry_types=learn_config.entry_types,
                    sections=learn_config.context_sections,
                    timeout=learn_config.context_fetch_timeout,
                )
                lesson_cache.set(sid, query, context_block, ids)
            except Exception as e:
                if learn_config.fail_open:
                    logger.debug("mubit.learn context fetch failed: %s", e)
                    context_block, ids = "", []
                else:
                    raise
        else:
            ids = lesson_cache.get_ids(sid, query)

        _record_recalled(ids)

        if context_block:
            kwargs = dict(kwargs)
            kwargs["system"] = inject_context_anthropic(
                kwargs.get("system"), context_block
            )

        return kwargs

    def _maybe_extract(kwargs, result):
        """Heuristic auto-extraction from the assistant reply (parity w/ OpenAI)."""
        if not learn_config.auto_extract:
            return
        try:
            assistant_text = _anthropic_response_text(result)
            if not assistant_text:
                return
            extracted = extract_structured_items(
                messages=kwargs.get("messages", []),
                assistant_text=assistant_text,
                model=kwargs.get("model", "unknown"),
                user_id=learn_config.user_id,
            )
            if extracted and hasattr(client, "_mubit_worker"):
                client._mubit_worker.enqueue(
                    run_manager.session_id, learn_config.agent_id, extracted
                )
        except Exception as e:
            if learn_config.fail_open:
                logger.warning(
                    "mubit.learn anthropic auto-extraction failed (suppressed): %s", e
                )
            else:
                raise

    if is_async:
        async def learn_create(*args, **kwargs):
            kwargs = _enrich_kwargs(kwargs)
            result = None
            try:
                result = await auto_create(*args, **kwargs)
                return result
            finally:
                run_manager.increment()
                if result is not None:
                    _maybe_extract(kwargs, result)

        client.messages.create = learn_create
    else:
        def learn_create(*args, **kwargs):
            kwargs = _enrich_kwargs(kwargs)
            result = None
            try:
                result = auto_create(*args, **kwargs)
                return result
            finally:
                run_manager.increment()
                if result is not None:
                    _maybe_extract(kwargs, result)

        client.messages.create = learn_create

    client._mubit_learn_wrapped = True
    return client
