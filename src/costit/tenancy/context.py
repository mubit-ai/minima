"""The per-request tenant context: everything resolved from the caller's credential."""

from __future__ import annotations

from dataclasses import dataclass

from costit.memory.adapter import Memory
from costit.recommender.engine import Recommender
from costit.recommender.recstore import LaneCounter, RecStore


@dataclass(slots=True)
class TenantContext:
    """Resolved per-request scope. In single-tenant mode there is one of these
    (``org_id="default"``) wrapping the process singletons; in multi-tenant mode one is
    built/cached per org and bound to that org's own Mubit instance."""

    org_id: str
    memory: Memory
    recommender: Recommender
    recstore: RecStore
    lane_counter: LaneCounter
    lane_prefix: str
    mubit_endpoint: str

    def lane(self, namespace: str | None) -> str:
        """Intra-org sub-scope lane. The ORG boundary is the Mubit instance/key, not this
        string — so namespace is a benign within-org partition (team/project/env)."""
        return f"{self.lane_prefix}:{namespace or 'default'}"

    def counter_key(self, lane: str) -> str:
        """Org-qualified key so reflection cadence never mixes across orgs."""
        return f"{self.org_id}:{lane}"
