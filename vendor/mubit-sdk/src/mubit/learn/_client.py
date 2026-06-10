"""
MuBit Learn Client.

Lightweight urllib-based HTTP client for get_context() and reflect().
Follows the IngestWorker._post_ingest() pattern — no external deps.
"""

import json
import logging
import urllib.request
import urllib.error
from typing import List, Optional

logger = logging.getLogger("mubit.learn")


class LearnClient:
    """Minimal HTTP client for context retrieval and reflection."""

    def __init__(
        self,
        api_key: str,
        endpoint: str,
        context_timeout: float = 1.5,
        reflect_timeout: float = 10.0,
        attribution_timeout: float = 8.0,
    ):
        self._api_key = api_key
        self._endpoint = endpoint.rstrip("/")
        self._context_timeout = context_timeout
        self._attribution_timeout = attribution_timeout
        self._reflect_timeout = reflect_timeout

    def get_context(
        self,
        session_id: str,
        query: str,
        max_token_budget: int = 2048,
        entry_types: Optional[List[str]] = None,
        sections: Optional[List[str]] = None,
        lane_filter: Optional[str] = None,
    ) -> str:
        """Fetch assembled context block for pre-LLM injection (hot path).

        Uses the short ``context_timeout`` budget. Returns the context_block
        string, or empty string on failure.
        """
        block, _ = self._fetch_context(
            session_id,
            query,
            self._context_timeout,
            max_token_budget,
            entry_types,
            sections,
            lane_filter,
        )
        return block

    def get_context_with_ids(
        self,
        session_id: str,
        query: str,
        max_token_budget: int = 2048,
        entry_types: Optional[List[str]] = None,
        sections: Optional[List[str]] = None,
        lane_filter: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> "tuple[str, List[str]]":
        """Fetch the context block plus the entry IDs of its source evidence.

        The IDs identify which memory entries were recalled into the context, so
        a later outcome can be attributed back to them. Defaults to the longer
        ``attribution_timeout``; the injection hot path passes the (configurable)
        ``context_fetch_timeout`` instead so a single call serves both injection
        and attribution. Returns ``("", [])`` on failure.
        """
        return self._fetch_context(
            session_id,
            query,
            timeout if timeout is not None else self._attribution_timeout,
            max_token_budget,
            entry_types,
            sections,
            lane_filter,
        )

    def _fetch_context(
        self,
        session_id: str,
        query: str,
        timeout: float,
        max_token_budget: int,
        entry_types: Optional[List[str]],
        sections: Optional[List[str]],
        lane_filter: Optional[str],
    ) -> "tuple[str, List[str]]":
        payload = {
            "run_id": session_id,
            "query": query,
            "format": "structured",
            "max_token_budget": max_token_budget,
        }
        if entry_types:
            payload["entry_types"] = entry_types
        if sections:
            payload["sections"] = sections
        if lane_filter:
            payload["lane"] = lane_filter

        try:
            resp = self._post("/v2/control/context", payload, timeout=timeout)
            block = resp.get("context_block", "")
            ids: List[str] = []
            for source in resp.get("sources", []) or []:
                sid = source.get("id") if isinstance(source, dict) else None
                if sid:
                    ids.append(sid)
            return block, ids
        except Exception as e:
            # Surfaced at warning (not debug) so a silently-empty recall — which
            # disables lesson injection and auto-attribution — is observable.
            logger.warning(
                "mubit.learn context fetch failed (non-fatal, timeout=%.1fs): %s",
                timeout,
                e,
            )
            return "", []

    def record_outcome(
        self,
        session_id: str,
        *,
        outcome: str,
        signal: float = 0.0,
        reference_id: str = "",
        entry_ids: Optional[List[str]] = None,
        rationale: str = "",
        agent_id: Optional[str] = None,
        verified_in_production: bool = False,
    ) -> None:
        """Record an outcome, optionally attributing it to recalled entries.

        Fire-and-forget. With an empty ``reference_id`` and a populated
        ``entry_ids`` this is a run-level outcome credited to every entry that
        was recalled into context for the call. ``verified_in_production`` is a
        strong trust boost and is only ever set by an explicit caller (the auto
        path never sets it).
        """
        try:
            payload: dict = {
                "run_id": session_id,
                "reference_id": reference_id or "",
                "outcome": outcome,
                "signal": signal,
            }
            if rationale:
                payload["rationale"] = rationale
            if agent_id:
                payload["agent_id"] = agent_id
            if entry_ids:
                payload["entry_ids"] = list(entry_ids)
            if verified_in_production:
                payload["verified_in_production"] = True
            self._post("/v2/control/outcome", payload, timeout=self._attribution_timeout)
        except Exception as e:
            # Outcome writes carry entry_id attribution and run post-hoc (not on
            # the injection hot path), so they use the longer attribution timeout.
            # Surfaced at warning (not debug) so a silently-dropped attribution —
            # which breaks the outcome->entry feedback loop — is observable.
            logger.warning(
                "mubit.learn record_outcome failed (non-fatal, timeout=%.1fs): %s",
                self._attribution_timeout,
                e,
            )

    def reflect(
        self,
        session_id: str,
        step_id: Optional[str] = None,
        checkpoint_id: Optional[str] = None,
        last_n_items: Optional[int] = None,
    ) -> None:
        """Trigger reflection for a session. Fire-and-forget."""
        try:
            payload = {"run_id": session_id}
            if step_id:
                payload["step_id"] = step_id
            if checkpoint_id:
                payload["checkpoint_id"] = checkpoint_id
            if last_n_items:
                payload["last_n_items"] = last_n_items
            self._post("/v2/control/reflect", payload, timeout=self._reflect_timeout)
        except Exception as e:
            logger.debug("mubit.learn reflect failed (non-fatal): %s", e)

    def _post(self, path: str, payload: dict, timeout: float = 5.0) -> dict:
        if not self._api_key:
            return {}

        body = json.dumps(payload).encode("utf-8")
        url = f"{self._endpoint}{path}"

        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "User-Agent": "mubit-sdk-python-learn/0.1.0",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status >= 400:
                logger.debug("mubit.learn HTTP %d for %s", response.status, path)
                return {}
            return json.loads(response.read().decode("utf-8"))
