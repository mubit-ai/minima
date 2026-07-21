"""Preference pairs assembled from recovery-ladder chains.

When a harness re-routes after a verified failure and reports the child feedback with
``parent_rec_id``, the failed parent and the succeeding child form a same-task
preference pair (loser -> winner). Aggregated win rates feed a bounded adjustment to
the capability PRIOR at scoring time — never a post-hoc re-rank, so Thompson's logged
propensities stay valid.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from threading import Lock
from typing import Protocol, runtime_checkable

from minima.logging import get_logger
from minima.memory.records import TRUSTED_LABEL_SOURCES, clamp01
from minima.recommender.decisionlog import DecisionRecord
from minima.schemas.common import OutcomeLabel
from minima.schemas.feedback import FeedbackRequest

log = get_logger("minima.pairs")

# Only deterministic or judge-labeled child successes count as a preference signal;
# caller-asserted ("human") and unlabeled outcomes are too gameable to learn from.
PAIR_EVIDENCE_SOURCES = ("gate", "judge")


@dataclass(slots=True)
class PreferencePair:
    org_id: str
    lane: str
    cluster: str
    winner_model_id: str
    loser_model_id: str
    escalation_reason: str | None
    ts: float
    evidence: str


def assemble_pair(
    parent: DecisionRecord,
    child_req: FeedbackRequest,
    *,
    child_cluster: str,
    child_evidence_source: str,
) -> PreferencePair | None:
    """Return a pair when the recovery chain qualifies, else None.

    Qualifies when the parent is reconciled as a trusted (or gate-caused) failure, the
    child succeeded with gate/judge evidence, and both rungs are the same task cluster.
    """
    if not parent.reconciled or parent.realized_outcome != "failure":
        return None
    parent_trusted = parent.evidence_source in TRUSTED_LABEL_SOURCES
    if not parent_trusted and child_req.escalation_reason != "gate_failed":
        return None
    if child_req.outcome != OutcomeLabel.success:
        return None
    if child_evidence_source not in PAIR_EVIDENCE_SOURCES:
        return None
    if parent.cluster != child_cluster:
        return None
    loser = parent.realized_model_id or parent.chosen_model_id
    winner = child_req.chosen_model_id
    if winner == loser:
        # Same-model retry (e.g. higher effort) succeeded — no between-model preference.
        return None
    return PreferencePair(
        org_id=parent.org_id,
        lane=parent.lane,
        cluster=parent.cluster,
        winner_model_id=winner,
        loser_model_id=loser,
        escalation_reason=child_req.escalation_reason,
        ts=time.time(),
        evidence=child_evidence_source,
    )


@runtime_checkable
class PairStore(Protocol):
    def put(self, pair: PreferencePair) -> None: ...

    def win_rates(self, cluster: str) -> dict[tuple[str, str], tuple[int, int]]: ...


# TODO: durable (SQL) backend — in-memory only for now, pairs are lost on restart.
class MemoryPairStore:
    """In-process pair store: one retention-capped deque per org, thread-safe."""

    def __init__(self, retention: int = 512):
        self._retention = retention
        self._data: dict[str, deque[PreferencePair]] = {}
        self._lock = Lock()

    def put(self, pair: PreferencePair, org_id: str | None = None) -> None:
        if org_id is not None:
            pair.org_id = org_id
        with self._lock:
            dq = self._data.get(pair.org_id)
            if dq is None:
                dq = deque(maxlen=self._retention)
                self._data[pair.org_id] = dq
            dq.append(pair)

    def win_rates(
        self, cluster: str, org_id: str | None = None
    ) -> dict[tuple[str, str], tuple[int, int]]:
        with self._lock:
            if org_id is not None:
                buckets = [self._data.get(org_id)] if org_id in self._data else []
            else:
                buckets = list(self._data.values())
            pairs = [p for dq in buckets if dq is not None for p in dq if p.cluster == cluster]
        wins: dict[tuple[str, str], int] = {}
        for p in pairs:
            key = (p.winner_model_id, p.loser_model_id)
            wins[key] = wins.get(key, 0) + 1
        out: dict[tuple[str, str], tuple[int, int]] = {}
        for (winner, loser), n in wins.items():
            total = n + wins.get((loser, winner), 0)
            out[(winner, loser)] = (n, total)
            if (loser, winner) not in wins:
                out[(loser, winner)] = (0, total)
        return out


class OrgScopedPairStore:
    """Binds a shared pair-store backend to one org (mirrors OrgScopedDecisionLog)."""

    def __init__(self, backend: MemoryPairStore, org_id: str):
        self._backend = backend
        self._org_id = org_id

    def put(self, pair: PreferencePair) -> None:
        self._backend.put(pair, self._org_id)

    def win_rates(self, cluster: str) -> dict[tuple[str, str], tuple[int, int]]:
        return self._backend.win_rates(cluster, self._org_id)


def pair_prior_adjustment(
    prior: float,
    model_id: str,
    rates: dict[tuple[str, str], tuple[int, int]],
    *,
    min_n: int,
    weight: float,
) -> float:
    """Bounded prior nudge from directed win rates: +/- weight/2 max, clamped to [0, 1]."""
    deltas = [
        weight * (wins / total - 0.5)
        for (winner, _loser), (wins, total) in rates.items()
        if winner == model_id and total >= min_n > 0
    ]
    if not deltas:
        return prior
    return clamp01(prior + sum(deltas) / len(deltas))
