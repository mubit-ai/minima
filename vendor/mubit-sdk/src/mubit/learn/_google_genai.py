"""
MuBit Learn Google GenAI Wrapper.

Extends auto-capture with pre-call lesson retrieval and injection
for google.genai.Client.models.generate_content().
"""

import logging
import time
from typing import Any, Optional

from mubit.auto._context import get_current_span, is_async_callable, is_capture_enabled
from mubit.auto._items import build_items
from mubit.auto._worker import IngestWorker
from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig
from mubit.learn._extraction import extract_structured_items
from mubit.learn._injection import inject_context_openai
from mubit.learn._lesson_cache import LessonCache
from mubit.learn._run_manager import RunManager

logger = logging.getLogger("mubit.learn")


def _extract_query_from_contents(contents: Any) -> str:
    """Extract query text from google.genai contents parameter.

    Contents can be:
    - str: plain text prompt
    - list[str | Part | Content]: list of parts
    - Content: a single Content object
    """
    if isinstance(contents, str):
        return contents[:200]

    if isinstance(contents, list):
        texts = []
        for item in reversed(contents):
            if isinstance(item, str):
                texts.append(item)
                break
            # Content object with parts
            if hasattr(item, "parts"):
                for part in item.parts:
                    if hasattr(part, "text") and part.text:
                        texts.append(part.text)
                if texts:
                    break
            # Part object
            if hasattr(item, "text") and item.text:
                texts.append(item.text)
                break
        return " ".join(texts)[:200]

    # Single Content object
    if hasattr(contents, "parts"):
        parts = []
        for part in contents.parts:
            if hasattr(part, "text") and part.text:
                parts.append(part.text)
        return " ".join(parts)[:200]

    return str(contents)[:200]


def _extract_response_text(response: Any) -> str:
    """Extract text from GenerateContentResponse."""
    try:
        if hasattr(response, "text"):
            return response.text or ""
    except Exception:
        pass

    try:
        if hasattr(response, "candidates") and response.candidates:
            candidate = response.candidates[0]
            if hasattr(candidate, "content") and candidate.content:
                parts = candidate.content.parts or []
                texts = [p.text for p in parts if hasattr(p, "text") and p.text]
                return "\n".join(texts)
    except Exception:
        pass

    return ""


def _contents_to_messages(contents: Any) -> list:
    """Convert google.genai contents to OpenAI-style messages for ingestion."""
    messages = []
    if isinstance(contents, str):
        messages.append({"role": "user", "content": contents})
    elif isinstance(contents, list):
        for item in contents:
            if isinstance(item, str):
                messages.append({"role": "user", "content": item})
            elif hasattr(item, "role") and hasattr(item, "parts"):
                parts_text = []
                for part in (item.parts or []):
                    if hasattr(part, "text") and part.text:
                        parts_text.append(part.text)
                if parts_text:
                    role = "assistant" if item.role == "model" else (item.role or "user")
                    messages.append({"role": role, "content": "\n".join(parts_text)})
            elif hasattr(item, "text") and item.text:
                messages.append({"role": "user", "content": item.text})
    elif hasattr(contents, "parts"):
        parts_text = []
        for part in (contents.parts or []):
            if hasattr(part, "text") and part.text:
                parts_text.append(part.text)
        if parts_text:
            messages.append({"role": "user", "content": "\n".join(parts_text)})

    return messages


def _inject_context_genai(contents: Any, context_block: str) -> Any:
    """Inject context into google.genai contents.

    Prepends context as a system-like instruction in the contents.
    """
    if not context_block or not context_block.strip():
        return contents

    memory_text = (
        f"<memory_context>\n{context_block}\n</memory_context>\n\n"
        "Use the above memory context to inform your response.\n\n---\n\n"
    )

    if isinstance(contents, str):
        return memory_text + contents

    if isinstance(contents, list) and contents:
        first = contents[0]
        if isinstance(first, str):
            return [memory_text + first] + contents[1:]
        # For structured content, prepend a text part
        try:
            from google.genai import types as genai_types
            context_content = genai_types.Content(
                parts=[genai_types.Part(text=memory_text)],
                role="user",
            )
            return [context_content] + list(contents)
        except ImportError:
            return contents

    return contents


def wrap_google_genai_learn(
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
) -> Any:
    """Wrap a google.genai Client with learn (inject + ingest) capabilities."""
    if not hasattr(client, "models"):
        return client

    if getattr(client, "_mubit_learn_wrapped", None) is True:
        return client

    models = client.models

    # Set up ingest worker for auto-capture
    worker = IngestWorker(api_key=mubit_api_key, endpoint=mubit_endpoint)
    worker.start()

    # Wrap generate_content
    if hasattr(models, "generate_content"):
        original_generate = models.generate_content

        def _record_recalled(ids):
            run_manager.set_recalled_ids(ids)
            span = get_current_span()
            if span is not None:
                span.recalled_entry_ids = list(ids or [])

        def _enrich_kwargs(kwargs):
            if not learn_config.inject_lessons:
                return kwargs

            contents = kwargs.get("contents")
            if contents is None and len(kwargs) > 0:
                # contents might be a positional arg handled by caller
                return kwargs

            query = _extract_query_from_contents(contents)
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
                kwargs["contents"] = _inject_context_genai(
                    kwargs.get("contents"), context_block
                )

            return kwargs

        def _capture_interaction(kwargs, response, full_text=None):
            """Capture the interaction for ingestion.

            ``full_text`` overrides response-text extraction for the streaming
            path, where text is accumulated from chunks rather than a single
            response object.
            """
            try:
                contents = kwargs.get("contents")
                messages = _contents_to_messages(contents)
                assistant_text = (
                    full_text if full_text is not None
                    else _extract_response_text(response)
                )
                model_name = kwargs.get("model", "unknown")

                items = build_items(
                    messages=messages,
                    assistant_text=assistant_text,
                    model=str(model_name),
                    latency_ms=0,
                    capture=capture,
                    min_length=min_length,
                    user_id=learn_config.user_id,
                )
                if items:
                    span = get_current_span()
                    sid = getattr(span, "session_id", None) or run_manager.session_id
                    aid = getattr(span, "agent_id", None) or learn_config.agent_id
                    worker.enqueue(sid, aid, items)

                # Auto-extraction
                if learn_config.auto_extract and assistant_text:
                    extracted = extract_structured_items(
                        messages=messages,
                        assistant_text=assistant_text,
                        model=str(model_name),
                        user_id=learn_config.user_id,
                    )
                    if extracted:
                        span = get_current_span()
                        sid = getattr(span, "session_id", None) or run_manager.session_id
                        aid = getattr(span, "agent_id", None) or learn_config.agent_id
                        worker.enqueue(sid, aid, extracted)
            except Exception as e:
                # Honor fail_open like the context-injection path above: strict-mode
                # users (fail_open=False) must see capture/extraction failures, not
                # have them silently swallowed.
                if learn_config.fail_open:
                    logger.warning(
                        "mubit.learn genai capture failed (fail_open, suppressed): %s", e
                    )
                else:
                    raise

        def _normalize_positional(args, kwargs):
            """Move positional (model, contents) into kwargs for uniform handling."""
            if args and "contents" not in kwargs:
                if len(args) >= 2:
                    kwargs["model"] = args[0]
                    kwargs["contents"] = args[1]
                    args = args[2:]
                elif len(args) == 1:
                    kwargs["contents"] = args[0]
                    args = ()
            return args, kwargs

        is_async = is_async_callable(original_generate)

        if is_async:
            async def learn_generate_content(*args, **kwargs):
                args, kwargs = _normalize_positional(args, kwargs)
                kwargs = _enrich_kwargs(kwargs)
                result = None
                try:
                    result = await original_generate(*args, **kwargs)
                    return result
                finally:
                    run_manager.increment()
                    if result is not None:
                        _capture_interaction(kwargs, result)

            models.generate_content = learn_generate_content
        else:
            def learn_generate_content(*args, **kwargs):
                args, kwargs = _normalize_positional(args, kwargs)
                kwargs = _enrich_kwargs(kwargs)
                result = None
                try:
                    result = original_generate(*args, **kwargs)
                    return result
                finally:
                    run_manager.increment()
                    if result is not None:
                        _capture_interaction(kwargs, result)

            models.generate_content = learn_generate_content

    # Wrap generate_content_stream similarly, accumulating chunk text so the
    # streamed interaction is captured on completion (parity with non-streaming).
    if hasattr(models, "generate_content_stream"):
        original_stream = models.generate_content_stream

        is_stream_async = is_async_callable(original_stream)

        if is_stream_async:
            async def learn_generate_stream(*args, **kwargs):
                args, kwargs = _normalize_positional(args, kwargs)
                kwargs = _enrich_kwargs(kwargs)
                result = await original_stream(*args, **kwargs)
                run_manager.increment()
                return _GenaiAsyncWrappedStream(result, kwargs, _capture_interaction)

            models.generate_content_stream = learn_generate_stream
        else:
            def learn_generate_stream(*args, **kwargs):
                args, kwargs = _normalize_positional(args, kwargs)
                kwargs = _enrich_kwargs(kwargs)
                result = original_stream(*args, **kwargs)
                run_manager.increment()
                return _GenaiSyncWrappedStream(result, kwargs, _capture_interaction)

            models.generate_content_stream = learn_generate_stream

    client._mubit_learn_wrapped = True
    client._mubit_worker = worker
    return client


def _genai_chunk_text(chunk: Any) -> str:
    """Extract incremental text from a google.genai stream chunk."""
    try:
        if getattr(chunk, "text", None):
            return chunk.text or ""
    except Exception:
        pass
    return _extract_response_text(chunk)


class _GenaiSyncWrappedStream:
    """Wraps a sync google.genai stream to accumulate text and capture on finish."""

    def __init__(self, stream, kwargs, capture_cb):
        self._stream = stream
        self._kwargs = kwargs
        self._capture_cb = capture_cb
        self._chunks = []
        self._finished = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self._stream)
            t = _genai_chunk_text(chunk)
            if t:
                self._chunks.append(t)
            return chunk
        except StopIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        self._capture_cb(self._kwargs, None, full_text="".join(self._chunks))


class _GenaiAsyncWrappedStream:
    """Wraps an async google.genai stream to accumulate text and capture on finish."""

    def __init__(self, stream, kwargs, capture_cb):
        self._stream = stream
        self._kwargs = kwargs
        self._capture_cb = capture_cb
        self._chunks = []
        self._finished = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            chunk = await self._stream.__anext__()
            t = _genai_chunk_text(chunk)
            if t:
                self._chunks.append(t)
            return chunk
        except StopAsyncIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        self._capture_cb(self._kwargs, None, full_text="".join(self._chunks))
