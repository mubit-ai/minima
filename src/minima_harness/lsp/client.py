"""A minimal LSP client: one connection to one language-server process.

Owns the subprocess, a single background reader task (the only consumer of the server's
stdout), and a map of in-flight requests to futures. Speaks just the methods the ``lsp``
tool needs: initialize/shutdown plus definition, references, hover and documentSymbol.
Positions follow LSP conventions (zero-based line/character, UTF-16 code units).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from typing import Any

from minima_harness.lsp.protocol import (
    LspError,
    LspNotInstalled,
    LspServerDied,
    LspTimeout,
    encode_message,
    read_message,
)

INITIALIZE_TIMEOUT = 20.0  # first spawn + jedi's initial scan can be slow
REQUEST_TIMEOUT = 10.0

# pylsp's jedi plugins are on by default, but we enable them explicitly so behaviour does
# not depend on the server's ambient configuration.
PYLSP_SETTINGS: dict[str, Any] = {
    "pylsp": {
        "plugins": {
            "jedi_definition": {"enabled": True},
            "jedi_references": {"enabled": True},
            "jedi_hover": {"enabled": True},
            "jedi_symbols": {"enabled": True, "all_scopes": True},
        }
    }
}


def path_to_uri(path: Path) -> str:
    return path.resolve().as_uri()


def utf16_len(text: str) -> int:
    """Length of ``text`` in UTF-16 code units — LSP's default position encoding."""
    return len(text.encode("utf-16-le")) // 2


class LspClient:
    """One live connection to a language server. Not safe for concurrent ops on its own;
    callers serialize per-server via the manager's op-lock."""

    def __init__(self, cmd: list[str], language_id: str) -> None:
        self._cmd = cmd
        self._language_id = language_id
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._open: dict[str, int] = {}  # uri -> last version sent
        self._next_id = 0
        self._alive = False
        self._write_lock = asyncio.Lock()

    @property
    def alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    @property
    def pid(self) -> int:
        return self._proc.pid if self._proc is not None else -1

    @property
    def pgid(self) -> int:
        # start_new_session=True makes the child its own group leader, so pgid == pid.
        return self.pid

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
        except (OSError, ValueError) as exc:
            raise LspNotInstalled(f"could not launch {self._cmd[0]!r}: {exc}") from exc
        self._alive = True
        self._reader_task = asyncio.ensure_future(self._read_loop())

    async def initialize(self, root: Path) -> dict[str, Any]:
        result = await self.request(
            "initialize",
            {
                "processId": os.getpid(),  # lets the server self-terminate if we die
                "rootUri": path_to_uri(root),
                "rootPath": str(root.resolve()),  # deprecated but pylsp still reads it
                "capabilities": {
                    "textDocument": {
                        "definition": {"linkSupport": False},
                        "references": {},
                        "hover": {"contentFormat": ["plaintext", "markdown"]},
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    },
                    "workspace": {"configuration": True, "workspaceFolders": False},
                },
                "initializationOptions": PYLSP_SETTINGS,
                "workspaceFolders": None,
            },
            timeout=INITIALIZE_TIMEOUT,
        )
        await self.notify("initialized", {})
        # Re-push settings: some servers ignore initializationOptions and only honour this.
        await self.notify("workspace/didChangeConfiguration", {"settings": PYLSP_SETTINGS})
        return result

    async def shutdown(self) -> None:
        if self.alive:
            with contextlib.suppress(LspError):
                await self.request("shutdown", None, timeout=REQUEST_TIMEOUT)
                await self.notify("exit", None)
        await self._terminate()

    async def _terminate(self) -> None:
        self._alive = False
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader_task
            self._reader_task = None
        proc = self._proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
        self._fail_all_pending(LspServerDied("client shut down"))

    # -- messaging ---------------------------------------------------------

    async def _write(self, payload: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise LspServerDied("server stdin not available")
        data = encode_message(payload)
        async with self._write_lock:
            proc.stdin.write(data)
            try:
                await proc.stdin.drain()
            except (ConnectionResetError, BrokenPipeError) as exc:
                raise LspServerDied(f"write failed: {exc}") from exc

    async def notify(self, method: str, params: Any) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        await self._write(msg)

    async def request(self, method: str, params: Any, *, timeout: float = REQUEST_TIMEOUT) -> Any:
        if not self.alive:
            raise LspServerDied("server is not running")
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        try:
            await self._write(msg)
            async with asyncio.timeout(timeout):
                return await fut
        except TimeoutError:
            self._alive = False
            raise LspTimeout(f"{method} timed out after {timeout:.0f}s") from None
        finally:
            self._pending.pop(rid, None)

    # -- reader / dispatch -------------------------------------------------

    async def _read_loop(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        try:
            while True:
                try:
                    msg = await read_message(proc.stdout)
                except LspServerDied:
                    break
                if msg is None:
                    break
                await self._dispatch(msg)
        finally:
            self._alive = False
            self._fail_all_pending(LspServerDied("server exited"))

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        if "id" in msg and ("result" in msg or "error" in msg):
            fut = self._pending.pop(msg["id"], None)  # response to one of our requests
            if fut is not None and not fut.done():
                if "error" in msg:
                    fut.set_exception(LspError(str(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
        elif "id" in msg:
            await self._answer_server_request(msg)  # server-initiated request — must reply
        # else: a notification (logMessage / progress / diagnostics) — ignore, never reply

    async def _answer_server_request(self, msg: dict[str, Any]) -> None:
        method = msg.get("method", "")
        rid = msg["id"]
        if method == "workspace/configuration":
            # one result per requested item; null = "use your defaults"
            items = (msg.get("params") or {}).get("items", [])
            result: Any = [None] * len(items)
        else:
            # registerCapability, window/workDoneProgress/create, etc. → benign ack
            result = None
        with contextlib.suppress(LspError):
            await self._write({"jsonrpc": "2.0", "id": rid, "result": result})

    def _fail_all_pending(self, exc: Exception) -> None:
        pending = self._pending
        self._pending = {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(exc)

    # -- documents ---------------------------------------------------------

    async def did_open(self, path: Path) -> str:
        """Send the file's current content to the server and return its URI."""
        uri = path_to_uri(path)
        text = path.read_text(encoding="utf-8", errors="replace")
        version = self._open.get(uri, 0) + 1
        self._open[uri] = version
        await self.notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": uri,
                    "languageId": self._language_id,
                    "version": version,
                    "text": text,
                }
            },
        )
        return uri

    async def did_close(self, path: Path) -> None:
        uri = path_to_uri(path)
        if uri in self._open:
            await self.notify("textDocument/didClose", {"textDocument": {"uri": uri}})

    # -- operations --------------------------------------------------------

    async def definition(self, uri: str, position: dict[str, int]) -> Any:
        return await self.request(
            "textDocument/definition",
            {"textDocument": {"uri": uri}, "position": position},
        )

    async def references(self, uri: str, position: dict[str, int]) -> Any:
        return await self.request(
            "textDocument/references",
            {
                "textDocument": {"uri": uri},
                "position": position,
                "context": {"includeDeclaration": True},
            },
        )

    async def hover(self, uri: str, position: dict[str, int]) -> Any:
        return await self.request(
            "textDocument/hover",
            {"textDocument": {"uri": uri}, "position": position},
        )

    async def document_symbol(self, uri: str) -> Any:
        return await self.request(
            "textDocument/documentSymbol",
            {"textDocument": {"uri": uri}},
        )
