"""Learned recall scoring (F3, ``MINIMA_RECALL_UTILITY``, default off).

Per (lane, entry) utility tracker: entries credited when a feedback reinforces them,
debited when a failure-direction recall vote lands on them. The learned utility
re-weights each evidence row's SIMILARITY weight (a sigmoid-bounded [0.5, 1.5]
multiplier applied before aggregation) — never a candidate re-rank, so Thompson's
propensity contract is untouched. In-memory, TenantContext-scoped, size-bounded.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from threading import Lock

from minima.memory.records import RecalledEvidence

MULT_MIN = 0.5
MULT_MAX = 1.5
# Net-credit units at which the sigmoid reaches ~73% of its range.
UTILITY_SCALE = 3.0
# Bound on tracked (lane, entry) rows per store (oldest evicted).
ENTRY_CAP = 4096


class RecallUtilityStore:
    """Thread-safe per-tenant net-credit ledger over recalled entry ids."""

    def __init__(self) -> None:
        self._net: dict[tuple[str, str], float] = {}
        self._lock = Lock()

    def _bump(self, lane: str, entry_id: str, delta: float) -> None:
        if not entry_id:
            return
        key = (lane, entry_id)
        with self._lock:
            self._net[key] = self._net.get(key, 0.0) + delta
            while len(self._net) > ENTRY_CAP:
                self._net.pop(next(iter(self._net)))

    def credit(self, lane: str, entry_id: str, weight: float = 1.0) -> None:
        self._bump(lane, entry_id, abs(weight))

    def debit(self, lane: str, entry_id: str, weight: float = 1.0) -> None:
        self._bump(lane, entry_id, -abs(weight))

    def multiplier(self, lane: str, entry_ids: Iterable[str | None]) -> float:
        """Sigmoid-bounded [0.5, 1.5] weight multiplier; 1.0 for untracked entries.

        The first tracked id among ``entry_ids`` wins (an entry may be known under
        its recall entry_id or its durable reference_id).
        """
        with self._lock:
            for entry_id in entry_ids:
                if not entry_id:
                    continue
                net = self._net.get((lane, entry_id))
                if net is not None:
                    return MULT_MIN + (MULT_MAX - MULT_MIN) / (
                        1.0 + math.exp(-net / UTILITY_SCALE)
                    )
        return 1.0


def apply_recall_utility(
    evidence: list[RecalledEvidence], lane: str, store: RecallUtilityStore
) -> None:
    """Re-weight each evidence row's similarity score by its learned utility in place."""
    for ev in evidence:
        mult = store.multiplier(lane, (ev.entry_id, ev.reference_id))
        if mult != 1.0:
            ev.score = max(0.0, ev.score) * mult
