"""Provider protocol and the provider registry.

A provider owns the ``stream()`` implementation for one ``api`` id (e.g.
``anthropic-messages``). Real providers register themselves at import time in
Phase 1; the faux provider registers on demand for hermetic tests.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from minima_harness.ai.events import Event

if TYPE_CHECKING:
    from minima_harness.ai.types import Context, Model


@runtime_checkable
class Provider(Protocol):
    """A streaming provider bound to one ``Model.api`` id."""

    api_id: str

    def stream(
        self,
        model: Model,
        context: Context,
        *,
        options: dict | None = None,
        signal: object | None = None,
    ) -> AsyncIterator[Event]:
        """Yield streaming events, ending with ``DoneEvent`` or ``ErrorEvent``.

        Implementations are async generator functions (``async def`` with ``yield``), so
        the declared signature is a plain ``def`` returning ``AsyncIterator`` — calling it
        returns the iterator directly, no ``await``.
        """
        ...


# api id -> provider instance. Instances are reused; stateful providers (faux) expose
# per-test handles rather than mutating this singleton.
_REGISTRY: dict[str, Provider] = {}


def register_provider(api: str, provider: Provider) -> None:
    """Register (or replace) the provider for an ``api`` id."""
    _REGISTRY[api] = provider


def unregister_provider(api: str) -> None:
    _REGISTRY.pop(api, None)


def get_provider(api: str) -> Provider:
    try:
        return _REGISTRY[api]
    except KeyError:
        available = ", ".join(sorted(_REGISTRY)) or "<none>"
        raise KeyError(f"no provider registered for api {api!r} (available: {available})") from None


def registered_apis() -> list[str]:
    return sorted(_REGISTRY)
