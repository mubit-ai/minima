"""Pass-through auth: the caller's Mubit API key IS their credential.

No provisioning, no mnim_ keys. The caller passes their Mubit key as
``Authorization: Bearer <mubit_key>``; Minima uses it directly against the
configured MUBIT_ENDPOINT. One TenantContext is built and cached per key.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from threading import Lock

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.logging import get_logger
from minima.memory.adapter import Memory, MubitMemory
from minima.memory.recall_utility import RecallUtilityStore
from minima.recommender.classify_embed import load_embed_classifier
from minima.recommender.contextual import ContextualStore
from minima.recommender.decisionlog import DecisionLog, MemoryDecisionLog, OrgScopedDecisionLog
from minima.recommender.durablerefs import (
    DurableRefs,
    MemoryDurableRefs,
    OrgScopedDurableRefs,
)
from minima.recommender.engine import Recommender
from minima.recommender.pairs import MemoryPairStore, OrgScopedPairStore
from minima.recommender.recstore import LaneCounter, OrgScopedRecStore, RecStore
from minima.recommender.resets import ResetRegistry
from minima.tenancy.context import TenantContext


def _org_id(key: str) -> str:
    """Derive a stable org_id from a Mubit key (mbt_<instance>_...) or its hash."""
    parts = key.split("_", 3)
    if len(parts) >= 4 and parts[0] == "mbt" and parts[1]:
        return parts[1]
    return hashlib.sha256(key.encode()).hexdigest()[:16]


log = get_logger("minima.tenancy")


class PassthroughRuntime:
    """One process-wide runtime; per-key TenantContexts are lazily built and cached."""

    def __init__(
        self,
        *,
        settings: Settings,
        catalog_store: CatalogStore,
        recstore_backend: RecStore,
        lane_counter: LaneCounter,
        memory_factory: Callable[[str], Memory] | None = None,
        decision_log_backend: DecisionLog | None = None,
        durable_refs_backend: DurableRefs | None = None,
        pair_store_backend: MemoryPairStore | None = None,
    ):
        self._settings = settings
        self._embed_classifier = None
        if settings.minima_embed_classifier or settings.minima_classifier_required:
            self._embed_classifier = load_embed_classifier(
                settings.minima_classifier_artifact,
                required=settings.minima_classifier_required,
            )
            if self._embed_classifier is None:
                log.warning(
                    "embed_classifier_unavailable_running_regex",
                    artifact=settings.minima_classifier_artifact,
                )
            else:
                log.info(
                    "embed_classifier_loaded",
                    classifier_id=self._embed_classifier.classifier_id,
                )
        self._catalog_store = catalog_store
        self._recstore_backend = recstore_backend
        self._lane_counter = lane_counter
        self._memory_factory = memory_factory
        self._decision_log_backend = decision_log_backend or MemoryDecisionLog(
            settings.minima_decision_log_retention_days
        )
        self._durable_refs_backend = durable_refs_backend or MemoryDurableRefs()
        self._pair_store_backend = pair_store_backend or MemoryPairStore(
            settings.minima_pairs_retention
        )
        self._cache: dict[str, TenantContext] = {}
        self._resets_by_org: dict[str, ResetRegistry] = {}
        self._lock = Lock()

    def resolve(self, mubit_api_key: str) -> TenantContext:
        key_hash = hashlib.sha256(mubit_api_key.encode()).hexdigest()
        with self._lock:
            ctx = self._cache.get(key_hash)
            if ctx is not None:
                return ctx

        org_id = _org_id(mubit_api_key)
        if self._memory_factory is not None:
            memory = self._memory_factory(mubit_api_key)
        else:
            memory = MubitMemory(self._settings, api_key=mubit_api_key)
        scoped_recstore = OrgScopedRecStore(self._recstore_backend, org_id)
        scoped_decision_log = OrgScopedDecisionLog(self._decision_log_backend, org_id)
        scoped_durable_refs = OrgScopedDurableRefs(self._durable_refs_backend, org_id)
        scoped_pair_store = OrgScopedPairStore(self._pair_store_backend, org_id)
        with self._lock:
            resets = self._resets_by_org.setdefault(org_id, ResetRegistry())
        contextual = ContextualStore() if self._settings.minima_contextual_bandit else None
        recall_utility = RecallUtilityStore() if self._settings.minima_recall_utility else None
        recommender = Recommender(
            self._settings,
            memory,
            self._catalog_store,
            scoped_recstore,
            decision_log=scoped_decision_log,
            org_id=org_id,
            durable_refs=scoped_durable_refs,
            pair_store=scoped_pair_store,
            resets=resets,
            contextual=contextual,
            recall_utility=recall_utility,
            embed_classifier=self._embed_classifier,
        )
        ctx = TenantContext(
            org_id=org_id,
            memory=memory,
            recommender=recommender,
            recstore=scoped_recstore,
            lane_counter=self._lane_counter,
            lane_prefix=self._settings.minima_lane_prefix,
            mubit_endpoint=self._settings.mubit_endpoint,
            decision_log=scoped_decision_log,
            durable_refs=scoped_durable_refs,
            pair_store=scoped_pair_store,
            resets=resets,
            contextual=contextual,
            recall_utility=recall_utility,
        )
        with self._lock:
            existing = self._cache.get(key_hash)
            if existing is not None:
                return existing
            self._cache[key_hash] = ctx
            return ctx
