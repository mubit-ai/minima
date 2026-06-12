"""Shared psycopg2 ThreadedConnectionPool registry keyed by database URL.

All four durable store classes (RecStore, DecisionLog, Propensity, DurableRefs) call
get_pool() with the same URL, so the process holds exactly one connection pool per
database regardless of how many store objects are instantiated.
"""

from __future__ import annotations

import contextlib
from threading import Lock
from typing import Generator

import psycopg2
from psycopg2.pool import ThreadedConnectionPool

_pools: dict[str, ThreadedConnectionPool] = {}
_lock = Lock()


def get_pool(url: str, minconn: int = 1, maxconn: int = 5) -> ThreadedConnectionPool:
    with _lock:
        if url not in _pools:
            _pools[url] = ThreadedConnectionPool(minconn, maxconn, url)
        return _pools[url]


@contextlib.contextmanager
def cursor(url: str) -> Generator[psycopg2.extensions.cursor, None, None]:
    """Yield a cursor inside a committed transaction; return the connection to the pool."""
    pool = get_pool(url)
    conn = pool.getconn()
    try:
        with conn:  # commits on clean exit, rolls back on exception
            with conn.cursor() as cur:
                yield cur
    finally:
        pool.putconn(conn)
