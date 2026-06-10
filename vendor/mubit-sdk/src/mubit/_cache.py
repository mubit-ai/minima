"""
Generic TTL cache primitive, with semantic wrappers.

Thread-safe TTL + LRU-eviction cache. Used by PromptCache and LessonCache
to avoid network round-trips for recently-fetched prompts/lessons.
"""

import hashlib
import threading
import time
from typing import Dict, List, Optional, Tuple

# Unit-separator: safe delimiter for joining entry IDs into one cache value.
_IDS_SEP = "\x1f"


class TTLCache:
    """Thread-safe TTL-bounded in-process cache with LRU eviction."""

    def __init__(self, ttl_seconds: float = 60.0, max_entries: int = 100):
        self._store: Dict[str, Tuple[float, str]] = {}
        self._ttl = ttl_seconds
        self._max = max_entries
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[str]:
        """Return cached value or None on miss/expiry."""
        with self._lock:
            entry = self._store.get(key)
            if entry and (time.monotonic() - entry[0]) < self._ttl:
                return entry[1]
            if entry:
                del self._store[key]
            return None

    def set(self, key: str, value: str) -> None:
        """Store a value with TTL. Evicts oldest entry if over capacity."""
        with self._lock:
            if len(self._store) >= self._max and key not in self._store:
                oldest = min(self._store, key=lambda k: self._store[k][0])
                del self._store[oldest]
            self._store[key] = (time.monotonic(), value)

    def invalidate_prefix(self, prefix: str) -> None:
        """Remove all entries whose key starts with `prefix`."""
        with self._lock:
            keys = [k for k in self._store if k.startswith(prefix)]
            for k in keys:
                del self._store[k]

    def clear(self) -> None:
        """Clear all cached entries."""
        with self._lock:
            self._store.clear()


class PromptCache:
    """TTL cache for get_prompt() results, keyed by (agent_id, version_id)."""

    def __init__(self, ttl_seconds: float = 60.0, max_entries: int = 50):
        self._cache = TTLCache(ttl_seconds, max_entries)

    def get(self, agent_id: str, version_id: str = "") -> Optional[str]:
        return self._cache.get(f"{agent_id}:{version_id}")

    def set(self, agent_id: str, version_id: str, content: str) -> None:
        self._cache.set(f"{agent_id}:{version_id}", content)

    def invalidate(self, agent_id: str) -> None:
        """Remove all entries for an agent (called after set_prompt)."""
        self._cache.invalidate_prefix(f"{agent_id}:")

    def clear(self) -> None:
        self._cache.clear()


class LessonCache:
    """TTL cache for get_context() results, keyed by (session_id, query hash).

    Caches the recalled entry IDs alongside the context block so a cache hit
    still yields the IDs needed to attribute a later outcome (a block-only cache
    would silently break feedback() attribution within the TTL window).
    """

    def __init__(self, ttl_seconds: float = 30.0, max_entries: int = 100):
        self._cache = TTLCache(ttl_seconds, max_entries)
        self._ids = TTLCache(ttl_seconds, max_entries)

    def get(self, session_id: str, query: str) -> Optional[str]:
        return self._cache.get(self._key(session_id, query))

    def set(
        self,
        session_id: str,
        query: str,
        context_block: str,
        ids: Optional[List[str]] = None,
    ) -> None:
        key = self._key(session_id, query)
        self._cache.set(key, context_block)
        if ids is not None:
            self._ids.set(key, _IDS_SEP.join(ids))

    def get_ids(self, session_id: str, query: str) -> List[str]:
        raw = self._ids.get(self._key(session_id, query))
        return raw.split(_IDS_SEP) if raw else []

    def clear(self) -> None:
        self._cache.clear()
        self._ids.clear()

    @staticmethod
    def _key(session_id: str, query: str) -> str:
        qh = hashlib.md5(query.encode("utf-8", errors="replace")).hexdigest()[:12]
        return f"{session_id}:{qh}"
