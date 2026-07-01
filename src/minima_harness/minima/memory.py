"""HarnessMemory — the seam that lets a :class:`MinimaAgent` *use* Mubit memory, not just
Minima's model recommender.

The harness already *reads* Mubit (lessons + optimized prompt are injected via
``tui.mubit.effective_prompt``) but never *writes*: ``init_mubit`` sets ``auto_learn=False``
and nothing calls ``remember``/``outcome``/``reflect``. So the loop is open — lessons are
consumed but the agent's own coding outcomes never feed back, and the injected lessons
never improve. This seam closes it, mirroring how the server-side memory adapter does:

- :meth:`recall` — task-specific prior context, injected before the model runs.
- :meth:`record_outcome` — a trace + an outcome score, *attributed to the recommendation*
  (``idempotency_key``/``reference_id`` = ``recommendation_id``). Never fabricates: a judge
  abstention (``quality is None``) records the trace but no score.
- :meth:`end_session` — ``reflect`` + ``checkpoint`` so a run leaves distilled, durable memory.

The default is :class:`NoopHarnessMemory`, so :class:`MinimaAgent` behaves exactly as before
unless a :class:`MubitHarnessMemory` is wired in. The Mubit-backed impl is fail-open (memory
must never break a coding run) and bridges the *synchronous* mubit SDK off the event loop.
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

import anyio

_log = logging.getLogger("minima_harness.memory")

# Entry types worth recalling before a coding turn (distilled signal, not raw traces).
_RECALL_ENTRY_TYPES = ["lesson", "rule", "observation"]
# Hard caps so injected context can never blow the model's window or run away on cost.
_MAX_SNIPPETS = 5
_MAX_SNIPPET_CHARS = 240


@runtime_checkable
class HarnessMemory(Protocol):
    """The memory a :class:`MinimaAgent` talks to. Implementations must be fail-open."""

    async def recall(self, task: str, *, limit: int = _MAX_SNIPPETS) -> list[str]:
        """Short prior-context snippets relevant to ``task`` (may be empty)."""
        ...

    async def record_outcome(
        self,
        *,
        task: str,
        recommendation_id: str,
        model_id: str,
        outcome: str,
        quality: float | None,
        cost_usd: float,
        latency_ms: int,
        turns: int,
    ) -> None:
        """Persist this turn's realized outcome, attributed to ``recommendation_id``."""
        ...

    async def end_session(self) -> None:
        """Distil the session into durable memory (reflect + checkpoint)."""
        ...


class NoopHarnessMemory:
    """Memory disabled — the default. Every method is a no-op / empty."""

    async def recall(self, task: str, *, limit: int = _MAX_SNIPPETS) -> list[str]:
        return []

    async def record_outcome(
        self,
        *,
        task: str,
        recommendation_id: str,
        model_id: str,
        outcome: str,
        quality: float | None,
        cost_usd: float,
        latency_ms: int,
        turns: int,
    ) -> None:
        return None

    async def end_session(self) -> None:
        return None


def format_recall_block(snippets: list[str]) -> str:
    """Render recalled snippets as a compact, clearly-delimited system-prompt section."""
    lines = "\n".join(f"- {s}" for s in snippets)
    return (
        '<prior_learnings source="mubit">\n'
        "Lessons and outcomes from earlier work on this project; apply when relevant.\n"
        f"{lines}\n"
        "</prior_learnings>"
    )


def _snippet_of(entry: object) -> str:
    """Best-effort text of a recall entry (object attrs or dict), capped."""
    for attr in ("content", "text", "summary"):
        val = getattr(entry, attr, None)
        if isinstance(val, str) and val.strip():
            return val.strip()[:_MAX_SNIPPET_CHARS]
    if isinstance(entry, dict):
        for key in ("content", "text", "summary"):
            dval = entry.get(key)
            if isinstance(dval, str) and dval.strip():
                return dval.strip()[:_MAX_SNIPPET_CHARS]
    if isinstance(entry, str) and entry.strip():
        return entry.strip()[:_MAX_SNIPPET_CHARS]
    return ""


class MubitHarnessMemory:
    """Mubit-SDK-backed memory: session-scoped, fail-open, sync-SDK bridged off the loop.

    Relies on the module-level mubit context set up by ``tui.mubit.init_mubit``. Availability
    is checked per call so wiring order (init runs *after* the agent is built) is irrelevant —
    before init, every method degrades to the no-op path.
    """

    def __init__(self, *, session_id: str, agent_id: str = "minima-harness") -> None:
        self._session_id = session_id
        self._agent_id = agent_id

    def _ready(self) -> bool:
        try:
            from minima_harness.tui.mubit import available

            return available()
        except Exception:  # noqa: BLE001 - never let a probe break the caller
            return False

    async def recall(self, task: str, *, limit: int = _MAX_SNIPPETS) -> list[str]:
        if not task.strip() or not self._ready():
            return []
        cap = max(1, min(limit, _MAX_SNIPPETS))
        try:
            import mubit

            # No session_id: recall across the whole project (agent_id + project_id set at
            # init_mubit), so THIS run learns from PAST sessions on the repo — the point of a
            # coding agent's memory. Writes/reflect below stay session-scoped.
            entries = await anyio.to_thread.run_sync(
                lambda: mubit.recall(task, limit=cap, entry_types=_RECALL_ENTRY_TYPES)
            )
        except Exception:  # noqa: BLE001 - recall must never break a run
            _log.debug("mubit_recall_failed", exc_info=True)
            return []
        snippets: list[str] = []
        for entry in entries or []:
            text = _snippet_of(entry)
            if text:
                snippets.append(text)
            if len(snippets) >= cap:
                break
        return snippets

    async def record_outcome(
        self,
        *,
        task: str,
        recommendation_id: str,
        model_id: str,
        outcome: str,
        quality: float | None,
        cost_usd: float,
        latency_ms: int,
        turns: int,
    ) -> None:
        if not recommendation_id or not self._ready():
            return
        qtext = "n/a" if quality is None else round(quality, 3)
        trace = (
            f"model={model_id} outcome={outcome} quality={qtext} "
            f"cost_usd={round(cost_usd, 6)} latency_ms={latency_ms} turns={turns} "
            f":: {task.strip()[:160]}"
        )

        def _write() -> None:
            import mubit

            # The trace, attributed to the recommendation for provenance + dedup.
            mubit.remember(
                trace,
                intent="trace",
                session_id=self._session_id,
                agent_id=self._agent_id,
                idempotency_key=recommendation_id,
            )
            # Close the loop with a *real* outcome score tied to the recommendation. Never
            # fabricate — a judge abstention (quality is None) records the trace but no score,
            # so Mubit's reflection learns only from graded turns.
            if quality is not None:
                mubit.outcome(
                    float(quality),
                    outcome_label=outcome,
                    reference_id=recommendation_id,
                    session_id=self._session_id,
                )

        try:
            await anyio.to_thread.run_sync(_write)
        except Exception:  # noqa: BLE001 - write-back must never break a run
            _log.debug("mubit_record_outcome_failed", exc_info=True)

    async def end_session(self) -> None:
        if not self._ready():
            return

        def _close() -> None:
            import mubit

            # reflect() distils this session's traces/outcomes into lessons; checkpoint()
            # leaves a durable marker so a future run can reference where this one ended.
            mubit.reflect(session_id=self._session_id)
            mubit.checkpoint(label="session-end", session_id=self._session_id)

        try:
            await anyio.to_thread.run_sync(_close)
        except Exception:  # noqa: BLE001 - session teardown must never break shutdown
            _log.debug("mubit_end_session_failed", exc_info=True)
