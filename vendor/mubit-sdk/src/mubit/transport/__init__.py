"""Mubit SDK transport layer.

Provides access to the transport engine for advanced use cases.
The transport handles gRPC/HTTP auto-fallback and endpoint normalization.
"""

from mubit.client import _Transport as TransportEngine

__all__ = ["TransportEngine"]
