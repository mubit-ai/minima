"""Thin Python client for the Minima API."""

from minima_client import autocapture
from minima_client.client import AsyncMinimaClient, MinimaClient
from minima_client.errors import MinimaError

__all__ = ["MinimaClient", "AsyncMinimaClient", "MinimaError", "autocapture"]
