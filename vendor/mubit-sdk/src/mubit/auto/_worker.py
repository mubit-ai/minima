"""
MuBit Auto-Capture Background Worker.

Handles async ingestion of trace data to avoid blocking the main application thread.
Uses standard library (urllib, threading) to minimize dependencies.
"""

import atexit
import hashlib
import json
import logging
import os
import queue
import threading
import time
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("mubit.auto")


def _batch_idempotency_key(
    run_id: str, agent_id: str, items: List[Dict[str, Any]]
) -> str:
    """Stable key for an ingest batch, derived from its item IDs.

    Each item carries a unique ``item_id`` (built in build_items/extraction), so
    a retried batch with the same items yields the same key and the server
    dedups it. Falls back to hashing the texts when item_ids are absent.
    """
    parts = sorted(
        str(it.get("item_id") or it.get("text", "")) for it in items
    )
    digest = hashlib.sha256(
        ("\x1f".join([run_id, agent_id] + parts)).encode("utf-8", "replace")
    ).hexdigest()
    return f"auto-{digest[:32]}"


class IngestWorker:
    """Fire-and-forget background ingest worker."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        flush_interval: float = 2.0,
        max_batch: int = 50,
    ):
        self._api_key = api_key or os.environ.get("MUBIT_API_KEY", "")
        self._endpoint = (
            endpoint or os.environ.get("MUBIT_ENDPOINT", "http://127.0.0.1:3000")
        ).rstrip("/")
        self._queue: queue.Queue = queue.Queue(maxsize=10_000)
        self._flush_interval = flush_interval
        self._max_batch = max_batch
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._started = False

    def start(self) -> None:
        """Start the background worker thread."""
        if self._started:
            return
        self._started = True
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="mubit-auto-ingest"
        )
        self._thread.start()
        atexit.register(self.flush)

    def enqueue(self, run_id: str, agent_id: str, items: List[Dict[str, Any]]) -> None:
        """Enqueue items for background ingest. Never blocks or raises."""
        if not items:
            return

        try:
            self._queue.put_nowait(
                {
                    "run_id": run_id,
                    "agent_id": agent_id,
                    "items": items,
                }
            )
        except queue.Full:
            # Dropping items is better than crashing the user's app
            logger.warning(
                "mubit.auto ingest queue full, dropping %d items", len(items)
            )
        except Exception as e:
            logger.error("mubit.auto enqueue failed: %s", e)

    def flush(self) -> None:
        """Flush all pending items synchronously (called at shutdown)."""
        if not self._started:
            return
            
        # Drain the queue completely
        while not self._queue.empty():
            batch = self._drain()
            if batch:
                self._send_batch(batch)

    def stop(self) -> None:
        """Stop the worker thread gracefully."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self.flush()

    def _run(self) -> None:
        """Main loop for the background thread."""
        while not self._stop_event.is_set():
            # Wait for flush interval or stop signal
            if self._stop_event.wait(self._flush_interval):
                break
            
            batch = self._drain()
            if batch:
                self._send_batch(batch)

    def _drain(self) -> List[Dict[str, Any]]:
        """Drain up to max_batch items from the queue."""
        items = []
        while len(items) < self._max_batch:
            try:
                # Non-blocking get
                items.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return items

    def _send_batch(self, batch: List[Dict[str, Any]]) -> None:
        """Group by (run_id, agent_id) and send one ingest per group."""
        if not batch:
            return

        # Group items by (run_id, agent_id) to minimize HTTP requests
        groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for entry in batch:
            key = (entry["run_id"], entry["agent_id"])
            if key not in groups:
                groups[key] = []
            groups[key].extend(entry["items"])

        for (run_id, agent_id), items in groups.items():
            try:
                self._post_ingest(run_id, agent_id, items)
            except Exception as e:
                logger.debug("mubit.auto ingest failed (non-fatal): %s", e)

    def _post_ingest(
        self, run_id: str, agent_id: str, items: List[Dict[str, Any]]
    ) -> None:
        """Perform the actual HTTP POST using urllib."""
        if not self._api_key:
            # Can't ingest without API key
            return

        payload = {
            "run_id": run_id,
            "agent_id": agent_id,
            # Deterministic key over the batch's item IDs so a retry of the same
            # batch dedups server-side (the server ignores empty keys, so the
            # old empty default re-inserted on every retry).
            "idempotency_key": _batch_idempotency_key(run_id, agent_id, items),
            "parallel": False,
            "items": items,
        }
        
        body = json.dumps(payload).encode("utf-8")
        url = f"{self._endpoint}/v2/control/ingest"
        
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "User-Agent": "mubit-sdk-python-auto/0.3.2",
            },
            method="POST",
        )
        
        # Set a short timeout to avoid hanging the background thread
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status >= 400:
                logger.warning(
                    "mubit.auto ingest error: status %d", response.status
                )
