"""
MuBit Auto-Capture LiteLLM Callback.

Custom logger for LiteLLM that intercepts completion calls.
"""

import time
from typing import Any, Dict, Optional

from mubit.auto._context import get_current_span, is_capture_enabled
from mubit.auto._items import build_items
from mubit.auto._worker import IngestWorker


class MubitLiteLLMLogger:
    """LiteLLM custom callback that auto-captures calls into MuBit."""

    def __init__(
        self,
        session_id: str = "",
        agent_id: str = "auto",
        user_id: str = "",
        capture: str = "all",
        min_length: int = 0,
        mubit_api_key: Optional[str] = None,
        mubit_endpoint: Optional[str] = None,
    ):
        self.session_id = session_id
        self.agent_id = agent_id
        self.user_id = user_id
        self.capture = capture
        self.min_length = min_length
        self._worker = IngestWorker(api_key=mubit_api_key, endpoint=mubit_endpoint)
        self._worker.start()

    def log_success_event(
        self, kwargs: Dict[str, Any], response_obj: Any, start_time: float, end_time: float
    ) -> None:
        """Capture successful completions."""
        if not is_capture_enabled():
            return

        # Handle latency calculation safely
        try:
            # start_time/end_time can be datetime or float depending on LiteLLM version
            if hasattr(end_time, "timestamp") and hasattr(start_time, "timestamp"):
                latency_ms = (end_time.timestamp() - start_time.timestamp()) * 1000
            else:
                latency_ms = (float(end_time) - float(start_time)) * 1000
        except (TypeError, ValueError):
            latency_ms = 0.0

        span = get_current_span()
        sid = getattr(span, "session_id", None) or self.session_id
        aid = getattr(span, "agent_id", None) or self.agent_id
        uid = getattr(span, "user_id", None) or self.user_id

        messages = kwargs.get("messages", [])
        model = kwargs.get("model", "unknown")
        
        # Extract assistant text
        assistant_text = ""
        try:
            if hasattr(response_obj, "choices") and response_obj.choices:
                assistant_text = response_obj.choices[0].message.content or ""
        except (AttributeError, IndexError):
            pass

        items = build_items(
            messages=messages,
            assistant_text=assistant_text,
            model=model,
            latency_ms=latency_ms,
            capture=self.capture,
            min_length=self.min_length,
            user_id=uid,
        )

        if items:
            self._worker.enqueue(sid, aid, items)

    def log_failure_event(
        self, kwargs: Dict[str, Any], response_obj: Any, start_time: float, end_time: float
    ) -> None:
        """Capture failures as observations (optional, currently no-op)."""
        pass
