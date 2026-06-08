"""Run the synchronous Mubit SDK off the event loop.

The Mubit Python SDK is blocking (``requests``/``grpc``). Every adapter call goes
through a worker thread so FastAPI's event loop stays responsive.
"""

from __future__ import annotations

import functools
import inspect
from collections.abc import Callable
from typing import TypeVar

import anyio

T = TypeVar("T")

# anyio renamed ``cancellable`` -> ``abandon_on_cancel`` in 4.1. Detect once.
_ABANDON_KW = (
    "abandon_on_cancel"
    if "abandon_on_cancel" in inspect.signature(anyio.to_thread.run_sync).parameters
    else "cancellable"
)


async def run(func: Callable[..., T], *args: object, **kwargs: object) -> T:
    """Run a blocking call in a worker thread (not abandoned on cancel)."""
    call = functools.partial(func, *args, **kwargs)
    return await anyio.to_thread.run_sync(call)


async def run_cancellable(func: Callable[..., T], *args: object, **kwargs: object) -> T:
    """Run a blocking call, abandoning the thread if the await is cancelled.

    Used for the latency-bounded recall path: on timeout we stop waiting, while the
    abandoned thread finishes harmlessly in the background.
    """
    call = functools.partial(func, *args, **kwargs)
    if _ABANDON_KW == "abandon_on_cancel":
        return await anyio.to_thread.run_sync(call, abandon_on_cancel=True)
    return await anyio.to_thread.run_sync(call, cancellable=True)
