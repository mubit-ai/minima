"""FastAPI application factory and lifespan wiring."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI

from costit.api.errors import register_error_handlers
from costit.api.routers import feedback, health, models, recommend, strategies
from costit.catalog.refresh import refresh_loop
from costit.catalog.store import CatalogStore
from costit.config import Settings, get_settings
from costit.llm.registry import build_reasoner
from costit.logging import configure_logging
from costit.memory.adapter import Memory, MubitMemory
from costit.recommender.engine import Recommender
from costit.recommender.propensity import build_propensity
from costit.recommender.recstore import LaneCounter, RecStore, build_recstore
from costit.version import __version__


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    configure_logging(settings.costit_log_level)

    injected: dict = getattr(app.state, "_injected", {})
    catalog_store: CatalogStore = injected.get("catalog_store") or CatalogStore(settings)
    memory: Memory = injected.get("memory") or MubitMemory(settings)
    recstore: RecStore = injected.get("recstore") or build_recstore(settings)
    recommender: Recommender = injected.get("recommender") or Recommender(
        settings,
        memory,
        catalog_store,
        recstore,
        reasoner=build_reasoner(settings),
        propensity=build_propensity(settings),
    )

    app.state.catalog_store = catalog_store
    app.state.memory = memory
    app.state.recstore = recstore
    app.state.lane_counter = LaneCounter()
    app.state.recommender = recommender

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
    start_refresh: bool = True,
) -> FastAPI:
    app = FastAPI(title="Costit", version=__version__, lifespan=lifespan)
    app.state.settings = settings or get_settings()
    app.state._injected = {
        "memory": memory,
        "catalog_store": catalog_store,
        "recstore": recstore,
        "recommender": recommender,
    }
    app.state._start_refresh = start_refresh

    register_error_handlers(app)
    app.include_router(recommend.router)
    app.include_router(feedback.router)
    app.include_router(models.router)
    app.include_router(strategies.router)
    app.include_router(health.router)
    return app


app = create_app()
