"""Warm registry of language-server connections, shared process-wide.

A language server is expensive to start (spawn + initial indexing), so we keep one alive
per ``(language, repo-root)`` and reuse it across tool calls. Because the harness has no
single async shutdown hook (Textual's ``App.run`` is synchronous and ``--print`` just
returns), teardown is belt-and-suspenders: an explicit async :func:`shutdown_all` for paths
that can await it, plus a synchronous ``atexit`` handler that kills the process groups so no
server is ever orphaned.
"""

from __future__ import annotations

import asyncio
import atexit
import os
import signal
import time
from pathlib import Path

from minima_harness.lsp.client import LspClient
from minima_harness.lsp.protocol import LspError

# language -> server command (argv). v1: Python via pylsp. Add entries to extend.
LANGUAGE_SERVERS: dict[str, list[str]] = {"python": ["pylsp"]}


class LspManager:
    def __init__(self) -> None:
        self._clients: dict[tuple[str, str], LspClient] = {}
        self._op_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._create_lock = asyncio.Lock()
        # (pid, pgid) of every server we've spawned, for the synchronous atexit sweep.
        self._procs: list[tuple[int, int]] = []

    def op_lock(self, language: str, root: str) -> asyncio.Lock:
        """A per-server lock; held by the tool around didOpen→op→didClose so concurrent
        calls to the same server can't interleave on its stdin. Different repos run free."""
        key = (language, root)
        lock = self._op_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._op_locks[key] = lock
        return lock

    async def get(self, language: str, root: str) -> LspClient:
        """Return a live server for ``(language, root)``, lazily spawning/respawning."""
        cmd = LANGUAGE_SERVERS.get(language)
        if cmd is None:
            raise LspError(f"no language server configured for {language!r}")
        key = (language, root)
        async with self._create_lock:
            client = self._clients.get(key)
            if client is not None and client.alive:
                return client
            if client is not None:  # dead → drop before respawning
                self._clients.pop(key, None)
            client = LspClient(cmd, language)
            await client.start()  # raises LspNotInstalled on a bad binary
            await client.initialize(Path(root))
            self._clients[key] = client
            self._procs.append((client.pid, client.pgid))
            return client

    async def shutdown_all(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.shutdown()
            except Exception:  # noqa: BLE001 - teardown is best-effort
                pass


_MANAGER: LspManager | None = None


def get_manager() -> LspManager:
    """The process-global manager, shared by the headless and TUI paths. Constructs on
    first use and registers the atexit reaper exactly once."""
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = LspManager()
        atexit.register(_atexit_cleanup)
    return _MANAGER


async def shutdown_all() -> None:
    """Gracefully stop all servers if a manager was ever created; a no-op otherwise."""
    if _MANAGER is not None:
        await _MANAGER.shutdown_all()


def _atexit_cleanup() -> None:
    """Synchronous last-resort reaper. The event loop may already be gone, so we can only
    signal process groups — no awaiting. ``start_new_session=True`` made each server a group
    leader (pgid == pid), so killing the group sweeps any jedi child processes too."""
    mgr = _MANAGER
    if mgr is None:
        return
    procs = list(mgr._procs)  # noqa: SLF001 - same module; intentional access
    for _pid, pgid in procs:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    deadline = time.monotonic() + 1.0
    for pid, pgid in procs:
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)  # still alive?
            except OSError:
                break
            time.sleep(0.02)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
