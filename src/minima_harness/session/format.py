from __future__ import annotations

import time
import uuid
from enum import StrEnum

from pydantic import BaseModel, Field


class EntryType(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    SYSTEM = "system"


def new_id() -> str:
    """A short, unique entry/session id (first 12 hex chars of uuid4)."""
    return uuid.uuid4().hex[:12]


def now_ts() -> float:
    return time.time()


class SessionEntry(BaseModel):
    """One node in the session tree. Append-only; never mutated once written."""

    id: str
    parent_id: str | None = None
    type: EntryType
    ts: float = Field(default_factory=now_ts)
    payload: dict
    label: str | None = None  # optional bookmark label (for /tree)
