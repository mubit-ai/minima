from __future__ import annotations

import asyncio

import pytest

from minima_harness.lsp.protocol import LspServerDied, encode_message, read_message


def _reader(data: bytes) -> asyncio.StreamReader:
    r = asyncio.StreamReader()
    r.feed_data(data)
    r.feed_eof()
    return r


async def test_roundtrip_with_newlines_and_unicode():
    # A body containing newlines and multibyte text must survive framing intact.
    payload = {"jsonrpc": "2.0", "id": 1, "method": "x", "params": {"t": "líne1\nlíne2 😀"}}
    assert await read_message(_reader(encode_message(payload))) == payload


def test_framing_uses_byte_length_not_char_length():
    framed = encode_message({"s": "😀😀"})  # 2 chars but 8 UTF-8 bytes
    header, _, body = framed.partition(b"\r\n\r\n")
    assert int(header.split(b":")[1]) == len(body)


async def test_eof_returns_none():
    r = asyncio.StreamReader()
    r.feed_eof()
    assert await read_message(r) is None


async def test_truncated_body_raises_server_died():
    framed = encode_message({"a": "bbbb"})
    r = asyncio.StreamReader()
    r.feed_data(framed[:-2])  # claim full length but drop 2 body bytes
    r.feed_eof()
    with pytest.raises(LspServerDied):
        await read_message(r)
