"""Resolve a Minima key to a per-org TenantContext, with warm per-org caches.

One ``TenantRuntime`` is shared across all orgs. It owns the things that are genuinely
global (the catalog, the Minima-owned reasoner, the recstore/propensity backends, the
lane counter) and lazily builds — then caches — a ``MubitMemory`` and a ``Recommender``
per org, each bound to that org's own Mubit instance.
"""

from __future__ import annotations

from collections.abc import Callable
from threading import Lock

from minima.catalog.store import CatalogStore
from minima.config import Settings
from minima.llm.base import Reasoner
from minima.logging import get_logger
from minima.memory.adapter import Memory, MubitMemory
from minima.recommender.engine import Recommender
from minima.recommender.propensity import OrgScopedPropensity, Propensity
from minima.recommender.recstore import LaneCounter, OrgScopedRecStore, RecStore
from minima.tenancy.context import TenantContext
from minima.tenancy.keys import parse_minima_key, verify_secret
from minima.tenancy.registry import TenantRecord, TenantStore
from minima.tenancy.secrets import SecretResolver

log = get_logger("minima.tenancy.runtime")


class TenantRuntime:
    def __init__(
        self,
        *,
        settings: Settings,
        catalog_store: CatalogStore,
        reasoner: Reasoner | None,
        recstore_backend: RecStore,
        propensity_backend: Propensity,
        lane_counter: LaneCounter,
        tenant_store: TenantStore,
        secret_resolver: SecretResolver,
        memory_factory: Callable[[str, str | None, str], Memory] | None = None,
    ):
        self._settings = settings
        self._catalog_store = catalog_store
        self._reasoner = reasoner
        self._recstore_backend = recstore_backend
        self._propensity_backend = propensity_backend
        self._lane_counter = lane_counter
        self._tenant_store = tenant_store
        self._secrets = secret_resolver
        # (endpoint, resolved_api_key, transport) -> Memory. Default builds a MubitMemory;
        # tests inject a factory returning a fake. Lets one process hold a client per org.
        self._memory_factory = memory_factory or self._build_mubit_memory
        self._memory: dict[str, Memory] = {}
        self._recommenders: dict[str, Recommender] = {}
        self._lock = Lock()

    @property
    def lane_counter(self) -> LaneCounter:
        return self._lane_counter

    @property
    def tenant_store(self) -> TenantStore:
        return self._tenant_store

    def _build_mubit_memory(self, endpoint: str, api_key: str | None, transport: str) -> Memory:
        return MubitMemory(
            self._settings, endpoint=endpoint, api_key=api_key, transport=transport
        )

    def resolve(self, minima_key: str | None) -> TenantContext | None:
        """Authenticate a Minima key and return its org context, or ``None`` if invalid."""
        if not minima_key:
            return None
        parsed = parse_minima_key(minima_key)
        if parsed is None:
            return None
        org_id, key_id, secret = parsed
        record = self._tenant_store.get(org_id)
        if record is None or record.key_id != key_id:
            return None
        if not verify_secret(secret, record.secret_hash):
            return None
        return self._context_for(record)

    def _context_for(self, record: TenantRecord) -> TenantContext:
        memory = self._get_memory(record)
        recommender = self._get_recommender(record, memory)
        return TenantContext(
            org_id=record.org_id,
            memory=memory,
            recommender=recommender,
            recstore=OrgScopedRecStore(self._recstore_backend, record.org_id),
            lane_counter=self._lane_counter,
            lane_prefix=record.lane_prefix,
            mubit_endpoint=record.mubit_endpoint,
        )

    def _get_memory(self, record: TenantRecord) -> Memory:
        with self._lock:
            mem = self._memory.get(record.org_id)
            if mem is not None:
                return mem
        api_key = self._secrets.resolve(record.mubit_api_key_ref)
        if not api_key:
            log.warning("tenant_mubit_key_unresolved", org_id=record.org_id)
        mem = self._memory_factory(record.mubit_endpoint, api_key, record.mubit_transport)
        with self._lock:
            # Re-check: another thread may have built it while we resolved the secret.
            existing = self._memory.get(record.org_id)
            if existing is not None:
                return existing
            self._memory[record.org_id] = mem
            return mem

    def _get_recommender(self, record: TenantRecord, memory: Memory) -> Recommender:
        with self._lock:
            rec = self._recommenders.get(record.org_id)
            if rec is not None:
                return rec
            rec = Recommender(
                self._settings,
                memory,
                self._catalog_store,
                OrgScopedRecStore(self._recstore_backend, record.org_id),
                reasoner=self._reasoner,
                propensity=OrgScopedPropensity(self._propensity_backend, record.org_id),
            )
            self._recommenders[record.org_id] = rec
            return rec
