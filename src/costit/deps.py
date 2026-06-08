"""FastAPI dependency providers (read singletons stashed on app.state)."""

from __future__ import annotations

from fastapi import Request

from costit.catalog.store import CatalogStore
from costit.config import Settings
from costit.memory.adapter import Memory
from costit.recommender.engine import Recommender
from costit.recommender.recstore import LaneCounter, RecStore


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_memory(request: Request) -> Memory:
    return request.app.state.memory


def get_catalog_store(request: Request) -> CatalogStore:
    return request.app.state.catalog_store


def get_recstore(request: Request) -> RecStore:
    return request.app.state.recstore


def get_lane_counter(request: Request) -> LaneCounter:
    return request.app.state.lane_counter


def get_recommender(request: Request) -> Recommender:
    return request.app.state.recommender
