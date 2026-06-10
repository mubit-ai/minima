"""
MuBit Learn Run Manager.

Manages session lifecycle: auto-generates session IDs, tracks call counts,
triggers background reflection at run boundaries or periodic intervals.
"""

import logging
import threading
import uuid
from typing import List, Optional

from mubit.learn._client import LearnClient
from mubit.learn._config import LearnConfig

logger = logging.getLogger("mubit.learn")


class RunManager:
    """Manages a single learn run (session) lifecycle."""

    def __init__(self, config: LearnConfig, client: LearnClient):
        self.session_id: str = config.session_id or uuid.uuid4().hex[:16]
        self.config = config
        self._client = client
        self._call_count = 0
        self._calls_since_last_reflect = 0
        self._lock = threading.Lock()
        self._ended = False
        # Entry IDs recalled for the most recent LLM call, so feedback() can
        # credit them by default when the caller omits entry_ids.
        self._last_recalled_ids: List[str] = []

    def set_recalled_ids(self, ids: Optional[List[str]]) -> None:
        """Record the entry IDs recalled for the latest call."""
        with self._lock:
            self._last_recalled_ids = [i for i in (ids or []) if i]

    def last_recalled_ids(self) -> List[str]:
        """Return a copy of the most recently recalled entry IDs."""
        with self._lock:
            return list(self._last_recalled_ids)

    def increment(self) -> None:
        """Increment call count. Trigger periodic reflection if configured."""
        with self._lock:
            self._call_count += 1
            self._calls_since_last_reflect += 1
            n = self.config.reflect_after_n_calls
            if n and self._call_count % n == 0:
                last_n = self._calls_since_last_reflect
                self._calls_since_last_reflect = 0
                self._background_reflect(last_n_items=last_n)

    def end(self) -> None:
        """End the run. Triggers reflection if auto_reflect is enabled."""
        with self._lock:
            if self._ended:
                return
            self._ended = True

        if self.config.auto_reflect:
            self._background_reflect()

    @property
    def call_count(self) -> int:
        return self._call_count

    def _background_reflect(self, last_n_items: Optional[int] = None) -> None:
        """Fire-and-forget reflection in a daemon thread."""
        sid = self.session_id

        def _do():
            try:
                self._client.reflect(sid, last_n_items=last_n_items)
            except Exception as e:
                logger.debug("mubit.learn background reflect failed: %s", e)

        t = threading.Thread(target=_do, daemon=True, name="mubit-learn-reflect")
        t.start()
