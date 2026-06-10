"""Tenancy: pass-through auth — callers use their Mubit API key directly."""

from __future__ import annotations

from minima.tenancy.context import TenantContext
from minima.tenancy.passthrough import PassthroughRuntime

__all__ = ["PassthroughRuntime", "TenantContext"]
