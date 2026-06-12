"""Shared Redis client registry keyed by URL.

RecStore and DurableRefs both call get_client() with the same URL, so the process
holds exactly one connection pool (redis.ConnectionPool is built into redis.Redis)
per Redis instance.
"""

from __future__ import annotations

from threading import Lock

import redis as _redis

_clients: dict[str, _redis.Redis] = {}
_lock = Lock()


def get_client(url: str) -> _redis.Redis:
    with _lock:
        if url not in _clients:
            _clients[url] = _redis.from_url(url, decode_responses=True)
        return _clients[url]
