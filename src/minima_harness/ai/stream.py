"""Unified generation entry points: ``stream()`` and ``complete()``.

Dispatches to the provider registered for ``model.api``. ``stream()`` returns an async
iterable that also exposes ``await s.result()`` (mirrors PI's TS stream object).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from minima_harness.ai.events import DoneEvent, ErrorEvent, Event
from minima_harness.ai.providers.base import get_provider

if TYPE_CHECKING:
    from minima_harness.ai.types import AssistantMessage, Context, Model


class Stream:
    """Async iterator over events with a ``.result()`` helper for the final message."""

    def __init__(self, gen: AsyncIterator[Event]) -> None:
        self._gen = gen
        self._result: AssistantMessage | None = None
        self._consumed = False

    def __aiter__(self) -> Stream:
        return self

    async def __anext__(self) -> Event:
        try:
            event = await self._gen.__anext__()
        except StopAsyncIteration as exc:
            self._consumed = True
            raise exc
        if isinstance(event, DoneEvent):
            self._result = event.message
            self._consumed = True
        elif isinstance(event, ErrorEvent):
            self._result = event.error
            self._consumed = True
        return event

    async def result(self) -> AssistantMessage:
        """Drain the stream and return the final assistant message (done or error)."""
        async for _ in self:
            pass
        if self._result is None:  # pragma: no cover - defensive
            raise RuntimeError("stream ended without a done/error event")
        return self._result


def stream(
    model: Model,
    context: Context,
    *,
    options: dict[str, Any] | None = None,
    signal: object | None = None,
) -> Stream:
    """Begin streaming a generation for ``model`` against ``context``.

    Returns a :class:`Stream` synchronously (matching PI's TS ``stream()`` which is not
    a promise); iterate it with ``async for`` and call ``await s.result()`` for the
    final message.
    """
    from minima_harness.ai.providers import ensure_providers_registered

    ensure_providers_registered()
    provider = get_provider(model.api)
    return Stream(provider.stream(model, context, options=options, signal=signal))


async def complete(
    model: Model,
    context: Context,
    *,
    options: dict[str, Any] | None = None,
    signal: object | None = None,
) -> AssistantMessage:
    """Non-streaming convenience: return the final assistant message."""
    s = stream(model, context, options=options, signal=signal)
    return await s.result()
