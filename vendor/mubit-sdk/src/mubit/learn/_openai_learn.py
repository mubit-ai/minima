"""
MuBit Learn OpenAI Wrapper.

Extends the existing auto-capture OpenAI wrapper with pre-call lesson
retrieval and injection. The auto wrapper handles ingestion (post-call);
this wrapper adds context enrichment (pre-call).
"""

import logging
from typing import Any, Optional

from mubit.auto._context import get_current_span, is_async_callable, is_async_client
from mubit.auto._openai import wrap_openai
from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig
from mubit.learn._extraction import extract_structured_items
from mubit.learn._injection import extract_query, inject_context_openai
from mubit.learn._lesson_cache import LessonCache
from mubit.learn._run_manager import RunManager

logger = logging.getLogger("mubit.learn")


def wrap_openai_learn(
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
    """Wrap an OpenAI client with learn (inject + ingest) capabilities.

    ``is_async`` should be passed explicitly by the caller that knows the
    concrete client class (the sync/async monkeypatch paths); when ``None`` it
    is inferred from the client class, then the create method as a fallback.
    """
    if not hasattr(client, "chat") or not hasattr(client.chat, "completions"):
        return client

    # Skip if already learn-wrapped
    if getattr(client, "_mubit_learn_wrapped", None) is True:
        return client

    # Apply auto-capture wrapping first (handles ingestion)
    wrap_openai(
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

    # Now re-wrap create() with the learn layer on top
    auto_create = client.chat.completions.create
    if is_async is None:
        is_async = is_async_client(client) or is_async_callable(auto_create)

    def _record_recalled(ids):
        """Stash recalled entry IDs so feedback() can credit them later."""
        run_manager.set_recalled_ids(ids)
        span = get_current_span()
        if span is not None:
            span.recalled_entry_ids = list(ids or [])

    def _enrich_kwargs(kwargs):
        """Inject context into messages before the LLM call (one recall)."""
        if not learn_config.inject_lessons:
            return kwargs

        messages = kwargs.get("messages", [])
        query = extract_query(messages)
        if not query:
            return kwargs

        sid = run_manager.session_id
        # One recall serves both injection and (later) attribution: fetch the
        # block + the source entry IDs together, on the configurable hot-path
        # timeout. IDs are cached alongside the block so a cache hit still
        # yields them for feedback() attribution.
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
            kwargs["messages"] = inject_context_openai(
                messages, context_block, learn_config.injection_position
            )

        return kwargs

    def _maybe_extract(kwargs, result):
        """Run auto-extraction on the response if enabled."""
        if not learn_config.auto_extract:
            return
        try:
            messages = kwargs.get("messages", [])
            # Extract assistant text from response
            assistant_text = ""
            if hasattr(result, "choices") and result.choices:
                assistant_text = getattr(result.choices[0].message, "content", "") or ""
            if not assistant_text:
                return

            extracted = extract_structured_items(
                messages=messages,
                assistant_text=assistant_text,
                model=kwargs.get("model", "unknown"),
                user_id=learn_config.user_id,
            )
            if extracted and hasattr(client, "_mubit_worker"):
                worker = client._mubit_worker
                worker.enqueue(run_manager.session_id, learn_config.agent_id, extracted)
        except Exception as e:
            # Honor fail_open like the context-injection path above: strict-mode
            # users (fail_open=False) must see extraction failures, not have them
            # silently swallowed.
            if learn_config.fail_open:
                logger.warning(
                    "mubit.learn auto-extraction failed (fail_open, suppressed): %s", e
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
                # Count every call (success or failure) so reflect_after_n_calls
                # stays accurate; extraction only runs on a real result.
                run_manager.increment()
                if result is not None:
                    _maybe_extract(kwargs, result)

        client.chat.completions.create = learn_create
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

        client.chat.completions.create = learn_create

    client._mubit_learn_wrapped = True
    return client
