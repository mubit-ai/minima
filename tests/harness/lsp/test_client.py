"""Unit tests for LspClient driven by in-memory streams — no real subprocess.

We construct the client and inject a fake process (a StreamReader for stdout, a buffer for
stdin), then start the real reader loop. This exercises request/response correlation, the
server-request acks, notification handling, and crash/timeout paths without launching pylsp.
"""

from __future__ import annotations

import asyncio
import contextlib

import pytest

from minima_harness.lsp.client import LspClient
from minima_harness.lsp.protocol import LspServerDied, LspTimeout, encode_message


class _FakeStdin:
    def __init__(self) -> None:
        self.buffer = bytearray()

    def write(self, data: bytes) -> None:
        self.buffer.extend(data)

    async def drain(self) -> None:
        return None


class _FakeProc:
    def __init__(self, stdout: asyncio.StreamReader) -> None:
        self.stdin = _FakeStdin()
        self.stdout = stdout
        self.returncode = None
        self.pid = 4321


def _make_client() -> tuple[LspClient, _FakeProc, asyncio.StreamReader]:
    client = LspClient(["pylsp"], "python")
    stdout = asyncio.StreamReader()
    proc = _FakeProc(stdout)
    client._proc = proc  # type: ignore[assignment]
    client._alive = True
    client._reader_task = asyncio.ensure_future(client._read_loop())
    return client, proc, stdout


async def _cleanup(client: LspClient, stdout: asyncio.StreamReader) -> None:
    stdout.feed_eof()
    if client._reader_task is not None:
        client._reader_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await client._reader_task


async def test_request_response_correlation_out_of_order():
    client, proc, stdout = _make_client()
    f1 = asyncio.ensure_future(client.request("a", {}, timeout=5))
    f2 = asyncio.ensure_future(client.request("b", {}, timeout=5))
    await asyncio.sleep(0.05)  # let both requests write (ids 1 then 2)
    stdout.feed_data(encode_message({"jsonrpc": "2.0", "id": 2, "result": "R2"}))
    stdout.feed_data(encode_message({"jsonrpc": "2.0", "id": 1, "result": "R1"}))
    assert await f1 == "R1"
    assert await f2 == "R2"
    await _cleanup(client, stdout)


async def test_acks_register_capability_with_null():
    client, proc, stdout = _make_client()
    stdout.feed_data(
        encode_message({"jsonrpc": "2.0", "id": 99, "method": "client/registerCapability"})
    )
    await asyncio.sleep(0.05)
    written = bytes(proc.stdin.buffer)
    assert b'"id":99' in written
    assert b'"result":null' in written
    await _cleanup(client, stdout)


async def test_acks_workspace_configuration_with_null_list():
    client, proc, stdout = _make_client()
    stdout.feed_data(
        encode_message(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "workspace/configuration",
                "params": {"items": [{}, {}]},
            }
        )
    )
    await asyncio.sleep(0.05)
    written = bytes(proc.stdin.buffer)
    assert b'"id":7' in written
    assert b'"result":[null,null]' in written
    await _cleanup(client, stdout)


async def test_notification_is_not_answered():
    client, proc, stdout = _make_client()
    stdout.feed_data(
        encode_message({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"m": "hi"}})
    )
    await asyncio.sleep(0.05)
    assert bytes(proc.stdin.buffer) == b""  # notifications get no reply
    await _cleanup(client, stdout)


async def test_pending_request_fails_when_server_dies():
    client, proc, stdout = _make_client()
    fut = asyncio.ensure_future(client.request("a", {}, timeout=5))
    await asyncio.sleep(0.02)
    stdout.feed_eof()  # server closes its pipe mid-flight
    with pytest.raises(LspServerDied):
        await fut


async def test_request_times_out_and_marks_dead():
    client, proc, stdout = _make_client()
    with pytest.raises(LspTimeout):
        await client.request("a", {}, timeout=0.02)
    assert client.alive is False
    await _cleanup(client, stdout)
