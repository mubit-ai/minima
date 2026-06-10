"""
MuBit Auto-Capture OpenAI Wrapper.

Intercepts OpenAI client calls to transparently capture inputs and outputs.
Supports both Sync and Async clients, and Streaming responses.
"""

import time
from typing import Any, Callable, Dict, Optional, Union

from mubit.auto._context import (
    get_current_span,
    is_async_callable,
    is_async_client,
    is_capture_enabled,
)
from mubit.auto._items import build_items
from mubit.auto._worker import IngestWorker


def wrap_openai(
    client: Any,
    *,
    session_id: str = "",
    agent_id: str = "auto",
    user_id: str = "",
    capture: str = "all",  # "all" | "output_only" | "input_only"
    min_length: int = 0,
    mubit_api_key: Optional[str] = None,
    mubit_endpoint: Optional[str] = None,
    is_async: Optional[bool] = None,
) -> Any:
    """
    Wrap an OpenAI client (Sync or Async) to auto-capture LLM calls into MuBit.
    
    Args:
        client: The OpenAI or AsyncOpenAI client instance.
        session_id: Default session/run ID for captured traces.
        agent_id: Default agent ID for captured traces.
        user_id: Default user ID.
        capture: Capture mode ("all", "input_only", "output_only").
        min_length: Minimum character length to capture.
        mubit_api_key: MuBit API key (overrides env var).
        mubit_endpoint: MuBit endpoint (overrides env var).
        
    Returns:
        The same client instance, with chat.completions.create wrapped.
    """
    # Duck-type check
    if not hasattr(client, "chat") or not hasattr(client.chat, "completions"):
        # Not an OpenAI client we recognize, return as is or warn?
        # For now, just return as is to be safe, maybe log a warning.
        return client

    # Initialize worker
    worker = IngestWorker(api_key=mubit_api_key, endpoint=mubit_endpoint)
    worker.start()

    original_create = client.chat.completions.create
    
    # Store reference for cleanup/idempotency
    # Note: explicit check for True to handle MagicMock clients in tests
    if getattr(client, "_mubit_wrapped", None) is True:
        return client

    # Prefer the explicit flag from the caller (which knows the concrete class);
    # else decide by client class, then the create method as a fallback.
    if is_async is None:
        is_async = is_async_client(client) or is_async_callable(original_create)

    # Capture context closure
    def _capture_logic(
        kwargs: Dict[str, Any],
        response: Any,
        latency_ms: float,
        full_text: str = None,
    ):
        span = get_current_span()
        sid = span.session_id if span else session_id
        aid = span.agent_id if span else agent_id
        uid = span.user_id if span else user_id
        
        # If user_id passed in wrapper is empty, but span has one, use span's.
        # But if wrapper has specific user_id, use that? 
        # Logic: Span overrides wrapper defaults usually, but wrapper config is "static".
        # Let's say Span context is most specific (dynamic), then wrapper config (static), then defaults.
        # Impl: 
        sid = getattr(span, "session_id", None) or session_id
        aid = getattr(span, "agent_id", None) or agent_id
        uid = getattr(span, "user_id", None) or user_id

        messages = kwargs.get("messages", [])
        model = kwargs.get("model", "unknown")

        # For non-streaming, extract text from response object
        if full_text is None and response:
            try:
                full_text = response.choices[0].message.content or ""
            except (AttributeError, IndexError):
                full_text = ""
        
        items = build_items(
            messages=messages,
            assistant_text=full_text or "",
            model=model,
            latency_ms=latency_ms,
            capture=capture,
            min_length=min_length,
            user_id=uid,
        )
        
        if items:
            worker.enqueue(sid, aid, items)

    # -------------------------------------------------------------------------
    # Async Wrapper
    # -------------------------------------------------------------------------
    async def async_wrapped_create(*args, **kwargs):
        if not is_capture_enabled():
            return await original_create(*args, **kwargs)

        t0 = time.monotonic()
        stream = kwargs.get("stream", False)
        
        if stream:
            response_stream = await original_create(*args, **kwargs)
            return _AsyncWrappedStream(
                response_stream, kwargs, t0, _capture_logic
            )
        
        response = await original_create(*args, **kwargs)
        latency_ms = (time.monotonic() - t0) * 1000
        _capture_logic(kwargs, response, latency_ms)
        return response

    # -------------------------------------------------------------------------
    # Sync Wrapper
    # -------------------------------------------------------------------------
    def sync_wrapped_create(*args, **kwargs):
        if not is_capture_enabled():
            return original_create(*args, **kwargs)

        t0 = time.monotonic()
        stream = kwargs.get("stream", False)

        if stream:
            response_stream = original_create(*args, **kwargs)
            return _SyncWrappedStream(
                response_stream, kwargs, t0, _capture_logic
            )

        response = original_create(*args, **kwargs)
        latency_ms = (time.monotonic() - t0) * 1000
        _capture_logic(kwargs, response, latency_ms)
        return response

    # Patch the method
    # print(f"DEBUG: patching {client} is_async={is_async}")
    if is_async:
        client.chat.completions.create = async_wrapped_create
    else:
        client.chat.completions.create = sync_wrapped_create

    # Mark as wrapped
    client._mubit_wrapped = True
    client._mubit_original_create = original_create
    client._mubit_worker = worker

    return client


# -----------------------------------------------------------------------------
# Stream Wrappers
# -----------------------------------------------------------------------------

class _SyncWrappedStream:
    """Wraps a sync iterator to accumulate content."""
    
    def __init__(self, stream, kwargs, start_time, capture_cb):
        self._stream = stream
        self._kwargs = kwargs
        self._start_time = start_time
        self._capture_cb = capture_cb
        self._chunks = []
        self._finished = False

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self._stream)
            self._process_chunk(chunk)
            return chunk
        except StopIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # If exited prematurely, we still try to finish capture
        self._finish()
        if hasattr(self._stream, "close"):
            self._stream.close()

    def _process_chunk(self, chunk):
        try:
            delta = chunk.choices[0].delta.content
            if delta:
                self._chunks.append(delta)
        except (AttributeError, IndexError):
            pass

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        latency_ms = (time.monotonic() - self._start_time) * 1000
        full_text = "".join(self._chunks)
        self._capture_cb(self._kwargs, None, latency_ms, full_text=full_text)


class _AsyncWrappedStream:
    """Wraps an async iterator to accumulate content."""
    
    def __init__(self, stream, kwargs, start_time, capture_cb):
        self._stream = stream
        self._kwargs = kwargs
        self._start_time = start_time
        self._capture_cb = capture_cb
        self._chunks = []
        self._finished = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            chunk = await self._stream.__anext__()
            self._process_chunk(chunk)
            return chunk
        except StopAsyncIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self._finish()
        if hasattr(self._stream, "aclose"):
            await self._stream.aclose()

    def _process_chunk(self, chunk):
        try:
            delta = chunk.choices[0].delta.content
            if delta:
                self._chunks.append(delta)
        except (AttributeError, IndexError):
            pass

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        latency_ms = (time.monotonic() - self._start_time) * 1000
        full_text = "".join(self._chunks)
        self._capture_cb(self._kwargs, None, latency_ms, full_text=full_text)
