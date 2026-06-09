"""FastAPI application factory and lifespan wiring."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI

from costit.api.errors import register_error_handlers
from costit.api.routers import admin, feedback, health, models, recommend, strategies
from costit.catalog.refresh import refresh_loop
from costit.catalog.store import CatalogStore
from costit.config import Settings, get_settings
from costit.llm.registry import build_reasoner
from costit.logging import configure_logging
from costit.memory.adapter import Memory, MubitMemory
from costit.recommender.engine import Recommender
from costit.recommender.propensity import OrgScopedPropensity, build_propensity
from costit.recommender.recstore import LaneCounter, OrgScopedRecStore, RecStore, build_recstore
from costit.tenancy.context import TenantContext
from costit.tenancy.registry import build_tenant_store
from costit.tenancy.runtime import TenantRuntime
from costit.tenancy.secrets import SecretResolver
from costit.version import __version__


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    configure_logging(settings.costit_log_level)

    injected: dict = getattr(app.state, "_injected", {})
    catalog_store: CatalogStore = injected.get("catalog_store") or CatalogStore(settings)
    recstore_backend: RecStore = injected.get("recstore") or build_recstore(settings)
    propensity_backend = build_propensity(settings)
    reasoner = build_reasoner(settings)
    lane_counter = LaneCounter()

    app.state.catalog_store = catalog_store
    app.state.lane_counter = lane_counter

    if settings.costit_multitenant:
        # Multi-tenant (T3): one runtime, per-org Mubit instance resolved per request.
        runtime: TenantRuntime = injected.get("tenant_runtime") or TenantRuntime(
            settings=settings,
            catalog_store=catalog_store,
            reasoner=reasoner,
            recstore_backend=recstore_backend,
            propensity_backend=propensity_backend,
            lane_counter=lane_counter,
            tenant_store=build_tenant_store(settings),
            secret_resolver=SecretResolver(),
        )
        app.state.tenant_runtime = runtime
        app.state.tenant_store = runtime.tenant_store
        app.state.default_tenant = None
    else:
        # Single-tenant: the env Mubit key is the one "default" org. State is org-scoped
        # to "default" so the storage layer is identical in both modes.
        org = settings.costit_default_org_id
        memory: Memory = injected.get("memory") or MubitMemory(settings)
        scoped_recstore = OrgScopedRecStore(recstore_backend, org)
        recommender: Recommender = injected.get("recommender") or Recommender(
            settings,
            memory,
            catalog_store,
            scoped_recstore,
            reasoner=reasoner,
            propensity=OrgScopedPropensity(propensity_backend, org),
        )
        app.state.memory = memory
        app.state.recstore = scoped_recstore
        app.state.recommender = recommender
        app.state.tenant_runtime = None
        app.state.default_tenant = TenantContext(
            org_id=org,
            memory=memory,
            recommender=recommender,
            recstore=scoped_recstore,
            lane_counter=lane_counter,
            lane_prefix=settings.costit_lane_prefix,
            mubit_endpoint=settings.mubit_endpoint,
        )

    refresh_task: asyncio.Task | None = None
    if getattr(app.state, "_start_refresh", True):
        refresh_task = asyncio.create_task(refresh_loop(settings, catalog_store))

    try:
        yield
    finally:
        if refresh_task is not None:
            refresh_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await refresh_task


def create_app(
    *,
    settings: Settings | None = None,
    memory: Memory | None = None,
    catalog_store: CatalogStore | None = None,
    recstore: RecStore | None = None,
    recommender: Recommender | None = None,
    tenant_runtime: TenantRuntime | None = None,
    start_refresh: bool = True,
) -> FastAPI:
    app = FastAPI(title="Costit", version=__version__, lifespan=lifespan)
    app.state.settings = settings or get_settings()
    app.state._injected = {
        "memory": memory,
        "catalog_store": catalog_store,
        "recstore": recstore,
        "recommender": recommender,
        "tenant_runtime": tenant_runtime,
    }
    app.state._start_refresh = start_refresh

    register_error_handlers(app)
    app.include_router(recommend.router)
    app.include_router(feedback.router)
    app.include_router(models.router)
    app.include_router(strategies.router)
    app.include_router(health.router)
    app.include_router(admin.router)
    return app


app = create_app()
