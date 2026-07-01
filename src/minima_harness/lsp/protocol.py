"""JSON-RPC base protocol for talking to a language server over stdio.

The LSP base protocol frames every message HTTP-style: an ASCII header block (at minimum
``Content-Length: <bytes>``), a blank ``\\r\\n`` line, then a JSON body whose UTF-8 byte
length equals the declared Content-Length. We hand-roll just enough of it to drive a
server — no external LSP library.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any


class LspError(Exception):
    """Base class for all LSP-client failures."""


class LspTimeout(LspError):
    """A request was sent but the server did not reply within the deadline."""


class LspServerDied(LspError):
    """The server process exited or closed its pipe (EOF or truncated message)."""


class LspNotInstalled(LspError):
    """The configured language-server binary could not be launched."""


def encode_message(payload: dict[str, Any]) -> bytes:
    """Frame a JSON-RPC payload with a Content-Length header.

    ``Content-Length`` counts *bytes* of the UTF-8 body, not characters — multibyte text
    would otherwise desync the stream.
    """
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    return header + body


async def read_message(reader: asyncio.StreamReader) -> dict[str, Any] | None:
    """Read one framed JSON-RPC message. Returns ``None`` on clean EOF (server gone).

    Header lines are CRLF-terminated; the body is read by exact byte count (it is not
    newline-delimited and may itself contain newlines). A truncated body — the server died
    mid-message — raises :class:`LspServerDied`.
    """
    headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if not line:  # EOF with no further data
            return None
        if line in (b"\r\n", b"\n"):  # blank line terminates the header block
            break
        text = line.decode("ascii", "replace").strip()
        if ":" in text:
            key, _, value = text.partition(":")
            headers[key.strip().lower()] = value.strip()

    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        length = 0
    if length <= 0:
        return None

    try:
        body = await reader.readexactly(length)
    except asyncio.IncompleteReadError as exc:
        raise LspServerDied("server closed mid-message") from exc
    return json.loads(body.decode("utf-8"))
