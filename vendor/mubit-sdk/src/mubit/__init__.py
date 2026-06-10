from .client import (
    AlreadyExistsError,
    AuthError,
    Client,
    ServerError,
    TransportError,
    UnsupportedFeatureError,
    ValidationError,
)

# --- New DX layer (Level 0-2 API) ---
from mubit._init import init
from mubit._helpers import (
    remember,
    recall,
    learned,
    context,
    forget,
    checkpoint,
    reflect,
    outcome,
    set_prompt,
    get_prompt,
    get_skills,
    set_skill,
)
from mubit._agent import agent, session, async_session

__all__ = [
    # New DX layer (Level 0-2)
    "init",
    "remember",
    "recall",
    "learned",
    "context",
    "forget",
    "checkpoint",
    "reflect",
    "outcome",
    "set_prompt",
    "get_prompt",
    "get_skills",
    "set_skill",
    "agent",
    "session",
    "async_session",
    # Existing (Level 3 — full Client API)
    "Client",
    "AlreadyExistsError",
    "AuthError",
    "ValidationError",
    "TransportError",
    "ServerError",
    "UnsupportedFeatureError",
]
