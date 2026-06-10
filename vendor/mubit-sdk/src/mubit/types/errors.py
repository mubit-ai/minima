"""Mubit SDK error types.

Re-exported from mubit.client for backwards compatibility.
These are the canonical error types used across the SDK.
"""

from mubit.client import (
    AuthError,
    ValidationError,
    TransportError,
    ServerError,
    UnsupportedFeatureError,
)

__all__ = [
    "AuthError",
    "ValidationError",
    "TransportError",
    "ServerError",
    "UnsupportedFeatureError",
]
