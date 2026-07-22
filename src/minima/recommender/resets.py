"""Posterior reset epochs — observable non-stationarity handling.

A reset epoch says "evidence for this model observed before ``at`` no longer describes
the deployed reality": either calibration drift was detected (CUSUM fired for a
(cluster, model)) or the provider silently swapped the model version underneath the
alias (the reported ``provider_model_snapshot`` changed). ``aggregate_by_model``
zero-weights records older than the epoch, so the posterior restarts from fresh
evidence instead of averaging across regimes.

The registry is in-memory and per-org (TenantContext-attached, like the engine's
exploration counters): a restart forgets resets, which only means pre-reset evidence
briefly counts again until the trigger re-fires.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from threading import Lock

CAUSE_CUSUM = "cusum"
CAUSE_SNAPSHOT_CHANGE = "snapshot_change"


@dataclass(slots=True, frozen=True)
class ResetEvent:
    model_id: str
    lane: str | None  # None = applies in every lane
    cluster: str | None  # None = applies in every cluster
    at: float
    cause: str


class ResetRegistry:
    """Per-org registry of posterior reset epochs plus last-seen provider snapshots."""

    def __init__(self) -> None:
        self._events: dict[tuple[str, str | None, str | None, str], ResetEvent] = {}
        self._last_snapshot: dict[str, str] = {}
        self._lock = Lock()

    def stamp(
        self,
        model_id: str,
        *,
        lane: str | None = None,
        cluster: str | None = None,
        cause: str,
        at: float | None = None,
        refresh: bool = False,
    ) -> None:
        """Record a reset epoch. First stamp wins per (model, lane, cluster, cause)
        unless ``refresh`` — a persistent CUSUM flag recomputed every refit must not
        keep pushing the epoch forward and zero evidence forever; a repeated snapshot
        change is a genuinely new regime and moves it."""
        key = (model_id, lane, cluster, cause)
        event = ResetEvent(
            model_id=model_id,
            lane=lane,
            cluster=cluster,
            at=at if at is not None else time.time(),
            cause=cause,
        )
        with self._lock:
            if not refresh and key in self._events:
                return
            self._events[key] = event

    def note_snapshot(self, model_id: str, snapshot: str) -> bool:
        """Track the last provider-reported snapshot per model; a change stamps a
        model-wide reset. Returns True when a reset was stamped."""
        with self._lock:
            prev = self._last_snapshot.get(model_id)
            self._last_snapshot[model_id] = snapshot
        if prev is not None and prev != snapshot:
            self.stamp(model_id, cause=CAUSE_SNAPSHOT_CHANGE, refresh=True)
            return True
        return False

    def epoch_for(self, model_id: str, lane: str, cluster: str) -> float | None:
        """Latest applicable reset epoch for this (model, lane, cluster), or None."""
        with self._lock:
            events = list(self._events.values())
        epochs = [
            e.at
            for e in events
            if e.model_id == model_id
            and (e.lane is None or e.lane == lane)
            and (e.cluster is None or e.cluster == cluster)
        ]
        return max(epochs) if epochs else None

    def active(self) -> list[ResetEvent]:
        with self._lock:
            events = list(self._events.values())
        return sorted(events, key=lambda e: e.at, reverse=True)
