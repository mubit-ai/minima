"""FastAPI application factory and lifespan wiring."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI

from minima.api.errors import register_error_handlers
from minima.api.routers import (
    calibration,
    feedback,
    health,
    models,
    recommend,
    savings,
    strategies,
)
from minima.catalog.refresh import refresh_loop
from minima.catalog.store import CatalogStore
from minima.config import Settings, get_settings
from minima.llm.registry import build_reasoner
from minima.logging import configure_logging
from minima.memory.adapter import Memory
from minima.recommender.decisionlog import build_decision_log
from minima.recommender.durablerefs import build_durable_refs
from minima.recommender.engine import Recommender
from minima.recommender.propensity import build_propensity
from minima.recommender.recstore import LaneCounter, RecStore, build_recstore
from minima.tenancy.passthrough import PassthroughRuntime
from minima.version import __version__


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    configure_logging(settings.minima_log_level)

    injected: dict = getattr(app.state, "_injected", {})
    catalog_store: CatalogStore = injected.get("catalog_store") or CatalogStore(settings)
    recstore_backend: RecStore = injected.get("recstore") or build_recstore(settings)
    propensity_backend = build_propensity(settings)
    decision_log_backend = build_decision_log(settings)
    reasoner = build_reasoner(settings)
    lane_counter = LaneCounter()

    app.state.catalog_store = catalog_store
    app.state.lane_counter = lane_counter
    injected_memory: Memory | None = injected.get("memory")
    app.state.passthrough_runtime = injected.get("passthrough_runtime") or PassthroughRuntime(
        settings=settings,
        catalog_store=catalog_store,
        reasoner=reasoner,
        recstore_backend=recstore_backend,
        propensity_backend=propensity_backend,
        lane_counter=lane_counter,
        memory_factory=(lambda _key: injected_memory) if injected_memory is not None else None,
        decision_log_backend=decision_log_backend,
        durable_refs_backend=build_durable_refs(settings),
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
    passthrough_runtime: PassthroughRuntime | None = None,
    start_refresh: bool = True,
) -> FastAPI:
    app = FastAPI(title="Minima", version=__version__, lifespan=lifespan)
    app.state.settings = settings or get_settings()
    app.state._injected = {
        "memory": memory,
        "catalog_store": catalog_store,
        "recstore": recstore,
        "recommender": recommender,
        "passthrough_runtime": passthrough_runtime,
    }
    app.state._start_refresh = start_refresh

    register_error_handlers(app)
    app.include_router(recommend.router)
    app.include_router(feedback.router)
    app.include_router(models.router)
    app.include_router(strategies.router)
    app.include_router(savings.router)
    app.include_router(calibration.router)
    app.include_router(health.router)
    return app


app = create_app()
