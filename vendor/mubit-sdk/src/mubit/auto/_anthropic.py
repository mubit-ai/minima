"""
MuBit Auto-Capture Anthropic Wrapper.

Intercepts Anthropic client calls to transparently capture inputs and outputs.
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


def wrap_anthropic(
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
    Wrap an Anthropic client (Sync or Async) to auto-capture LLM calls into MuBit.
    
    Args:
        client: The Anthropic or AsyncAnthropic client instance.
        session_id: Default session/run ID for captured traces.
        agent_id: Default agent ID for captured traces.
        user_id: Default user ID.
        capture: Capture mode ("all", "input_only", "output_only").
        min_length: Minimum character length to capture.
        mubit_api_key: MuBit API key (overrides env var).
        mubit_endpoint: MuBit endpoint (overrides env var).
        
    Returns:
        The same client instance, with messages.create wrapped.
    """
    # Duck-type check
    if not hasattr(client, "messages") or not hasattr(client.messages, "create"):
        return client

    # Initialize worker
    worker = IngestWorker(api_key=mubit_api_key, endpoint=mubit_endpoint)
    worker.start()

    original_create = client.messages.create
    
    # Idempotency check
    if getattr(client, "_mubit_wrapped", None) is True:
        return client

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
        sid = getattr(span, "session_id", None) or session_id
        aid = getattr(span, "agent_id", None) or agent_id
        uid = getattr(span, "user_id", None) or user_id

        # Anthropic messages structure
        messages = kwargs.get("messages", [])
        system = kwargs.get("system", None)
        model = kwargs.get("model", "unknown")
        
        # Merge system into messages for unified processing
        combined_messages = []
        if system:
            if isinstance(system, str):
                combined_messages.append({"role": "system", "content": system})
            elif isinstance(system, list):
                # Anthropic allows list of text blocks for system
                combined_messages.append({"role": "system", "content": system})
        combined_messages.extend(messages)

        # For non-streaming, extract text from response object
        if full_text is None and response:
            try:
                # Anthropic response: .content list of blocks
                if hasattr(response, "content") and isinstance(response.content, list):
                    full_text = "".join([
                        block.text for block in response.content 
                        if getattr(block, "type", "") == "text"
                    ])
            except (AttributeError, IndexError):
                full_text = ""
        
        items = build_items(
            messages=combined_messages,
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
            # Handle context manager stream (.stream()) vs iterator stream (stream=True)
            # But here we intercepted .create(), so it's just stream=True
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
    if is_async:
        client.messages.create = async_wrapped_create
    else:
        client.messages.create = sync_wrapped_create

    # Mark as wrapped
    client._mubit_wrapped = True
    client._mubit_original_create = original_create
    client._mubit_worker = worker

    return client


# -----------------------------------------------------------------------------
# Stream Wrappers (Anthropic specific)
# -----------------------------------------------------------------------------

class _SyncWrappedStream:
    """Wraps a sync Anthropic stream to accumulate content."""
    
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
            event = next(self._stream)
            self._process_event(event)
            return event
        except StopIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    def __enter__(self):
        # Support context manager usage if underlying supports it
        if hasattr(self._stream, "__enter__"):
            self._stream.__enter__()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._finish()
        if hasattr(self._stream, "__exit__"):
            self._stream.__exit__(exc_type, exc_val, exc_tb)
        elif hasattr(self._stream, "close"):
            self._stream.close()

    def _process_event(self, event):
        # Anthropic events: type="content_block_delta", delta.text
        try:
            if getattr(event, "type", "") == "content_block_delta":
                text = getattr(event.delta, "text", "")
                if text:
                    self._chunks.append(text)
        except AttributeError:
            pass

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        latency_ms = (time.monotonic() - self._start_time) * 1000
        full_text = "".join(self._chunks)
        self._capture_cb(self._kwargs, None, latency_ms, full_text=full_text)


class _AsyncWrappedStream:
    """Wraps an async Anthropic stream to accumulate content."""
    
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
            event = await self._stream.__anext__()
            self._process_event(event)
            return event
        except StopAsyncIteration:
            self._finish()
            raise
        except Exception:
            self._finish()
            raise

    async def __aenter__(self):
        if hasattr(self._stream, "__aenter__"):
            await self._stream.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self._finish()
        if hasattr(self._stream, "__aexit__"):
            await self._stream.__aexit__(exc_type, exc_val, exc_tb)
        elif hasattr(self._stream, "aclose"):
            await self._stream.aclose()

    def _process_event(self, event):
        try:
            if getattr(event, "type", "") == "content_block_delta":
                text = getattr(event.delta, "text", "")
                if text:
                    self._chunks.append(text)
        except AttributeError:
            pass

    def _finish(self):
        if self._finished:
            return
        self._finished = True
        latency_ms = (time.monotonic() - self._start_time) * 1000
        full_text = "".join(self._chunks)
        self._capture_cb(self._kwargs, None, latency_ms, full_text=full_text)
