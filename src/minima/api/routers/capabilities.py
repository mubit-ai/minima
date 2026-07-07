"""Capabilities endpoint — server feature-flag handshake.

Returns a stable JSON object describing which optional endpoints and constraint
fields the running server honours. The client reads this once at startup and
caches it per-session; all plan/workflow calls are guarded behind it so the
harness degrades gracefully when talking to an older server instance.
"""

from __future__ import annotations

from fastapi import APIRouter

from minima.schemas.capabilities import CapabilitiesResponse
from minima.version import __version__

router = APIRouter(prefix="/v1", tags=["capabilities"])

# Constraint fields that the engine actively filters on (not merely passes through).
_HONORED_CONSTRAINTS = [
    "candidate_models",
    "excluded_models",
    "max_cost_per_call",
    "min_quality",
    "require_prompt_caching",
    "max_latency_ms",
    "require_context_window",
    "allowed_providers",
]


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def capabilities() -> CapabilitiesResponse:
    """Report which optional server capabilities are available.

    No auth required — this is structural metadata, not org-scoped data.
    """
    return CapabilitiesResponse(
        plan=False,  # POST /v1/plan — implemented in PR C
        workflow=True,  # POST /v1/recommend/workflow — already exists
        api_version=__version__,
        honored_constraints=_HONORED_CONSTRAINTS,
    )
