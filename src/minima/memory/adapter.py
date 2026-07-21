"""The single integration point with the Mubit SDK.

Everything Minima knows about Mubit lives here. The recommender depends only on the
``Memory`` protocol, so tests can swap in a fake. All SDK calls are synchronous and
run in a worker thread; the recall path is latency-bounded.

Mubit run scoping: Minima uses the memory *lane* string as the run_id, so a namespace
maps to one stable run. That keeps ``upsert_key`` (scoped to run_id + user_id) stable
across requests, and recall over the same run finds the accumulated outcomes.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping, Sequence
from typing import Any, Protocol, runtime_checkable

import anyio
import httpx
from mubit import (
    AuthError,
    Client,
    ServerError,
    TransportError,
    UnsupportedFeatureError,
    ValidationError,
)

from minima.config import Settings
from minima.logging import get_logger
from minima.memory import threadpool
from minima.memory.records import OutcomeRecord, RecalledEvidence, RecallResult

log = get_logger("minima.memory")


def classify_memory_error(exc: BaseException) -> str | None:
    """Map a memory-layer exception to an honest, class-specific warning label.

    The Mubit SDK raises a precise error taxonomy (see mubit.client._map_http_error):
    auth (401/403), validation (400/404/422), unsupported (501), server (other 5xx), and
    transport (network unreachable / deadline). A bare `except Exception` that collapses all
    of these — plus any *local* bug (a KeyError in payload construction, a serialization
    error) — into one label makes an expired API key or a schema mismatch look identical to
    a Mubit outage. This keeps them distinct.

    Returns None for anything that is NOT a known Mubit error: that is a bug on our own side
    of the wire, and the caller labels it as such (never as an outage).
    """
    if isinstance(exc, AuthError):
        return "memory_auth_failed"
    if isinstance(exc, ValidationError):  # AlreadyExistsError (409) subclasses this too
        return "memory_rejected_payload"
    if isinstance(exc, UnsupportedFeatureError):
        return "memory_unsupported"
    if isinstance(exc, ServerError):
        return "memory_server_error"
    if isinstance(exc, TransportError):
        return "memory_unreachable"
    return None

def _f(value: object, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _parse_evidence(ev: Mapping[str, Any]) -> RecalledEvidence:
    superseded_by = str(ev.get("superseded_by") or "") or None
    return RecalledEvidence(
        entry_id=str(ev.get("id", "")),
        reference_id=(ev.get("reference_id") or None),
        score=_f(ev.get("score")),
        knowledge_confidence=_f(ev.get("knowledge_confidence")),
        # A superseded entry is stale by definition, even when is_stale lags the
        # supersession write — fold both so ranking never over-trusts a dead belief.
        is_stale=bool(ev.get("is_stale", False)) or superseded_by is not None,
        content=str(ev.get("content", "")),
        record=OutcomeRecord.from_metadata(ev.get("metadata_json")),
        referenceable=bool(ev.get("referenceable", False)),
        entry_type=str(ev.get("entry_type", "")),
        superseded_by=superseded_by,
    )


_FACT_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _parse_lookup_record(item: Mapping[str, Any]) -> RecalledEvidence | None:
    """Parse a single LookupResponse item (from POST /v2/core/lookup) into RecalledEvidence.

    The lookup response shape differs from recall: no ANN scores, metadata is a dict
    (not a JSON string), and id is a numeric CORE-plane node ID. Score and
    knowledge_confidence are set to 1.0 — an exact keyed match is maximally certain.

    Node IDs live in a different ID space from the control-plane fact UUIDs that
    record_outcome reinforces — a numeric node ID is never reinforceable. Only when
    the flattened metadata carries the fact UUID does the hit get a reference_id.
    """
    raw_id = item.get("id")
    if raw_id is None:
        return None
    meta = item.get("metadata")
    record = OutcomeRecord.from_metadata(meta)
    if record is None:
        return None
    entry_id = str(raw_id)
    fact_id = str(meta.get("id") or "") if isinstance(meta, Mapping) else ""
    reference_id = fact_id if _FACT_UUID_RE.match(fact_id) else None
    return RecalledEvidence(
        entry_id=entry_id,
        reference_id=reference_id,
        score=1.0,
        knowledge_confidence=1.0,
        is_stale=False,
        content="",
        record=record,
        referenceable=reference_id is not None,
    )


@runtime_checkable
class Memory(Protocol):
    async def recall(
        self,
        *,
        query: str,
        lane: str,
        user_id: str | None = None,
        limit: int = 25,
        entry_types: Sequence[str] | None = None,
        env_tags: Sequence[str] | None = None,
        timeout_ms: int | None = None,
    ) -> RecallResult: ...

    async def remember_outcome(
        self,
        *,
        content: str,
        record: OutcomeRecord,
        lane: str,
        upsert_key: str,
        idempotency_key: str,
        user_id: str | None = None,
        env_tags: Sequence[str] | None = None,
        importance: str = "medium",
        source: str = "human",
    ) -> str | None: ...

    async def record_outcome(
        self,
        *,
        lane: str,
        reference_id: str,
        outcome: str,
        signal: float,
        entry_ids: Sequence[str] | None = None,
        user_id: str | None = None,
        verified_in_production: bool = False,
        idempotency_key: str | None = None,
        rationale: str = "",
    ) -> dict: ...

    async def remember_lesson(
        self,
        *,
        content: str,
        lane: str,
        upsert_key: str,
        user_id: str | None = None,
        lesson_type: str = "success",
        lesson_scope: str = "session",
        importance: str = "high",
        env_tags: Sequence[str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> str | None: ...

    async def batch_insert(
        self, *, run_id: str, items: list[dict], deduplicate: bool = True
    ) -> dict: ...

    async def lookup(
        self,
        *,
        lane: str,
        match: list[dict],
        limit: int = 256,
    ) -> list[RecalledEvidence] | None: ...

    async def dereference(
        self, *, lane: str, reference_id: str
    ) -> RecalledEvidence | None: ...

    async def reflect(
        self, *, lane: str, user_id: str | None = None, include_linked_runs: bool = False
    ) -> dict: ...

    async def surface_strategies(
        self, *, lane: str, lesson_types: Sequence[str] | None = None, max_strategies: int = 5
    ) -> dict: ...

    async def health(self) -> dict: ...


class MubitMemory:
    """Concrete ``Memory`` backed by the Mubit SDK Client."""

    def __init__(
        self,
        settings: Settings,
        *,
        endpoint: str | None = None,
        api_key: str | None = None,
        transport: str | None = None,
    ):
        # endpoint/api_key/transport override settings so one process can hold a distinct
        # client per org (multi-tenancy). They default to the single-tenant env config.
        self._settings = settings
        self._endpoint = endpoint or settings.mubit_endpoint
        self._transport = transport or settings.mubit_transport
        resolved_key = api_key if api_key is not None else settings.mubit_api_key
        self._api_key = resolved_key
        kwargs: dict[str, Any] = {
            "endpoint": self._endpoint,
            "timeout_ms": settings.mubit_timeout_ms,
        }
        if resolved_key:
            kwargs["api_key"] = resolved_key
        if self._transport:
            kwargs["transport"] = self._transport
        self._client = Client(**kwargs)

    # ---- reads -----------------------------------------------------------------

    async def recall(
        self,
        *,
        query: str,
        lane: str,
        user_id: str | None = None,
        limit: int = 25,
        entry_types: Sequence[str] | None = None,
        env_tags: Sequence[str] | None = None,
        timeout_ms: int | None = None,
    ) -> RecallResult:
        settings = self._settings
        budget_ms = (
            timeout_ms if timeout_ms is not None else settings.minima_memory_recall_timeout_ms
        )
        # Low-level control query (the typed recall() wrapper drops rank_by / timestamps /
        # budget / explain). Default entry_types covers both intake paths: seed records
        # (batch_insert) land as "fact", feedback records (remember intent=observation)
        # as "observation"; Minima outcomes are still authoritatively selected by metadata
        # kind. prefer_current_run keeps everything in this lane's run while skipping
        # cross-run global-lesson overlays from other actors.
        resolved_types = (
            list(entry_types)
            if entry_types
            else [t.strip() for t in settings.minima_recall_entry_types.split(",") if t.strip()]
        )
        payload: dict[str, Any] = {
            "run_id": lane,
            "query": query,
            "mode": settings.minima_recall_mode,
            "limit": limit,
            "include_working_memory": False,
            "prefer_current_run": True,
            "lane_filter": lane,
            # Skip Mubit's per-query LLM answer synthesis: Minima parses only the
            # evidence list and discards the synthesized answer (it was most of the
            # ~600ms recall p95). Old servers ignore the unknown field.
            "evidence_only": True,
        }
        if user_id:
            payload["user_id"] = user_id
        if resolved_types:
            payload["entry_types"] = resolved_types
        if env_tags:
            payload["env_tags"] = list(env_tags)
        if settings.minima_recall_rank_by:
            payload["rank_by"] = settings.minima_recall_rank_by
        if settings.minima_recall_budget:
            payload["budget"] = settings.minima_recall_budget
        if settings.minima_recall_max_age_days > 0:
            payload["min_timestamp"] = int(
                time.time() - settings.minima_recall_max_age_days * 86_400
            )
        try:
            with anyio.move_on_after(budget_ms / 1000.0) as scope:
                raw = await threadpool.run_cancellable(self._client._control.query, payload)
            if scope.cancelled_caught:
                log.warning("recall_timeout", lane=lane, budget_ms=budget_ms)
                return RecallResult(evidence=[], degraded=True, timed_out=True)
            return self._parse_recall(raw)
        except Exception as exc:  # noqa: BLE001 — recall must never break a recommendation
            # Classify honestly: a Mubit outage, an auth failure, a rejected payload, and a
            # bug in our own recall path are distinct failures — do not conflate them all as
            # "memory_unavailable". Non-Mubit exceptions are our bug (memory_recall_bug), not
            # an outage. error_type makes the disguise visible without re-deriving it.
            warning = classify_memory_error(exc) or "memory_recall_bug"
            log.warning(
                "recall_error",
                lane=lane,
                warning=warning,
                error_type=type(exc).__name__,
                code=getattr(exc, "code", None),
                error=str(exc),
            )
            return RecallResult(evidence=[], degraded=True, error=str(exc), warning=warning)

    def _parse_recall(self, raw: object) -> RecallResult:
        data: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
        evidence: list[RecalledEvidence] = []
        for ev in data.get("evidence") or []:
            if not isinstance(ev, Mapping):
                continue
            evidence.append(_parse_evidence(ev))
        # DriftMonitor signals ride every query response (zeroed = no signal). They are
        # free loop-pathology telemetry: the engine surfaces the boolean flags as
        # diagnostic warnings so the harness recovery ladder hears about a looping or
        # consistently-failing lane before its own budget ledger does.
        signals = data.get("signals")
        drift: Mapping[str, Any] = signals if isinstance(signals, Mapping) else {}
        return RecallResult(
            evidence=evidence,
            degraded=bool(data.get("degraded", False)),
            raw_confidence=_f(data.get("confidence")),
            drift_repeated=bool(drift.get("repeated", False)),
            drift_stagnant=bool(drift.get("stagnant", False)),
            drift_score=_f(drift.get("drift_score"), default=-1.0),
            novelty_score=_f(drift.get("novelty_score"), default=-1.0),
        )

    async def lookup(
        self,
        *,
        lane: str,
        match: list[dict],
        limit: int = 256,
    ) -> list[RecalledEvidence] | None:
        """Deterministic keyed lookup via POST /v2/core/lookup.

        Returns all non-deleted outcome records for the given (lane, match) filters
        without touching ANN — results are stable across identical calls. Use for
        (cluster, model) keyed reads where recall flicker is unacceptable.

        Returns ``None`` when the keyed path is DEGRADED (timeout, transport error,
        or hosted policy rejection) so callers can tell "no records" from "channel
        down" and surface a warning instead of silently routing on thinner evidence.
        Shares the recall latency budget — the old unbudgeted path could stall a
        recommend for the full 30s client timeout.
        """
        budget_ms = self._settings.minima_memory_recall_timeout_ms
        try:
            with anyio.move_on_after(budget_ms / 1000.0) as scope:
                raw = await threadpool.run_cancellable(
                    self._client.lookup,
                    session_id=lane,
                    match=match,
                    limit=limit,
                )
            if scope.cancelled_caught:
                log.warning("lookup_timeout", lane=lane, budget_ms=budget_ms)
                return None
        except Exception as exc:  # noqa: BLE001 — lookup is additive; must not block a recommend
            log.warning("lookup_error", lane=lane, error=str(exc))
            return None
        if not isinstance(raw, list):
            return None
        results: list[RecalledEvidence] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            parsed = _parse_lookup_record(item)
            if parsed is not None:
                results.append(parsed)
        return results

    async def dereference(self, *, lane: str, reference_id: str) -> RecalledEvidence | None:
        """Exact re-read of a known durable record (the (cluster, model) outcome upsert).

        Returns None on any failure — the fast path is strictly additive to ANN recall.
        Shares the recall latency budget: this was the one read path that could stall a
        recommend for the full 30s client timeout if Mubit hung.
        """
        budget_ms = self._settings.minima_memory_recall_timeout_ms
        try:
            with anyio.move_on_after(budget_ms / 1000.0) as scope:
                raw = await threadpool.run_cancellable(
                    self._client.dereference, reference_id=reference_id, session_id=lane
                )
            if scope.cancelled_caught:
                log.warning("dereference_timeout", lane=lane, budget_ms=budget_ms)
                return None
        except Exception as exc:  # noqa: BLE001 — fast path must never break a recommendation
            log.warning("dereference_error", lane=lane, error=str(exc))
            return None
        if not isinstance(raw, Mapping) or raw.get("found") is False:
            return None
        ev = raw.get("evidence")
        if not isinstance(ev, Mapping) or not ev:
            return None
        parsed = _parse_evidence(ev)
        # Exact identity fetch: similarity is 1.0 by construction (same cluster key).
        parsed.score = 1.0
        if not parsed.reference_id:
            parsed.reference_id = reference_id
        return parsed

    # ---- writes ----------------------------------------------------------------

    async def remember_outcome(
        self,
        *,
        content: str,
        record: OutcomeRecord,
        lane: str,
        upsert_key: str,
        idempotency_key: str,
        user_id: str | None = None,
        env_tags: Sequence[str] | None = None,
        importance: str = "medium",
        source: str = "human",
    ) -> str | None:
        raw = await threadpool.run(
            self._client.remember,
            content=content,
            session_id=lane,
            agent_id="minima",
            intent="observation",
            metadata=record.to_metadata(),
            user_id=user_id,
            upsert_key=upsert_key,
            importance=importance,
            source=source,
            lane=lane,
            idempotency_key=idempotency_key,
            env_tags=list(env_tags) if env_tags else None,
            wait=True,
        )
        return _extract_record_id(raw)

    async def record_outcome(
        self,
        *,
        lane: str,
        reference_id: str,
        outcome: str,
        signal: float,
        entry_ids: Sequence[str] | None = None,
        user_id: str | None = None,
        verified_in_production: bool = False,
        idempotency_key: str | None = None,
        rationale: str = "",
    ) -> dict:
        # Low-level control op so we can pass idempotency_key (the typed
        # client.record_outcome wrapper drops it).
        payload = {
            "run_id": lane,
            "reference_id": reference_id,
            "outcome": outcome,
            "signal": signal,
            "rationale": rationale,
            "user_id": user_id,
            "verified_in_production": verified_in_production or None,
            "entry_ids": list(entry_ids) if entry_ids else None,
            "idempotency_key": idempotency_key,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        raw = await threadpool.run(self._client._control.record_outcome, payload)
        return raw if isinstance(raw, dict) else {}

    async def remember_lesson(
        self,
        *,
        content: str,
        lane: str,
        upsert_key: str,
        user_id: str | None = None,
        lesson_type: str = "success",
        lesson_scope: str = "session",
        importance: str = "high",
        env_tags: Sequence[str] | None = None,
        metadata: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> str | None:
        # A Lesson entry (intent="lesson") goes through the server's validation gate and
        # feeds reflect()/surface_strategies rule promotion. upsert_key keeps one durable
        # lesson per (cluster, model) so repeated wins reinforce rather than flood LTM.
        raw = await threadpool.run(
            self._client.remember,
            content=content,
            session_id=lane,
            agent_id="minima",
            intent="lesson",
            lesson_type=lesson_type,
            lesson_scope=lesson_scope,
            lesson_importance=importance,
            metadata=dict(metadata) if metadata else None,
            user_id=user_id,
            upsert_key=upsert_key,
            importance=importance,
            source="human",
            lane=lane,
            idempotency_key=idempotency_key,
            env_tags=list(env_tags) if env_tags else None,
            wait=True,
        )
        return _extract_record_id(raw)

    async def batch_insert(
        self, *, run_id: str, items: list[dict], deduplicate: bool = True
    ) -> dict:
        # Control batch_insert (/v2/control/batch_insert) is run-scoped and takes
        # {run_id, deduplicate, items}. The core route expects a bare array.
        raw = await threadpool.run(
            self._client._control.batch_insert,
            {"run_id": run_id, "deduplicate": deduplicate, "items": items},
        )
        return raw if isinstance(raw, dict) else {}

    async def reflect(
        self, *, lane: str, user_id: str | None = None, include_linked_runs: bool = False
    ) -> dict:
        raw = await threadpool.run(
            self._client.reflect,
            session_id=lane,
            user_id=user_id,
            include_linked_runs=include_linked_runs,
        )
        return raw if isinstance(raw, dict) else {}

    async def surface_strategies(
        self, *, lane: str, lesson_types: Sequence[str] | None = None, max_strategies: int = 5
    ) -> dict:
        raw = await threadpool.run(
            self._client.surface_strategies,
            session_id=lane,
            lesson_types=list(lesson_types) if lesson_types else None,
            max_strategies=max_strategies,
        )
        return raw if isinstance(raw, dict) else {}

    @property
    def endpoint(self) -> str:
        return self._endpoint

    async def health(self) -> dict:
        """Liveness probe via Mubit's core health route (no embedding, fast)."""
        base = self._endpoint.rstrip("/")
        url = f"{base}/v2/core/health"
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        try:
            async with httpx.AsyncClient(timeout=3.0) as http:
                resp = await http.get(url, headers=headers)
            return {
                "reachable": resp.status_code == 200,
                "transport": self._transport,
                "status_code": resp.status_code,
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "reachable": False,
                "transport": self._transport,
                "error": str(exc),
            }


def _extract_record_id(raw: object) -> str | None:
    if not isinstance(raw, Mapping):
        return None
    traces = raw.get("traces") or []
    if not traces or not isinstance(traces[0], Mapping):
        return None
    writes = traces[0].get("writes") or []
    if not writes or not isinstance(writes[0], Mapping):
        return None
    record_id = writes[0].get("record_id")
    return str(record_id) if record_id else None
