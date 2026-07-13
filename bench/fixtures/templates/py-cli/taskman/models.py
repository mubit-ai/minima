"""Core data model: the :class:`Task` dataclass and its invariants.

A task is a small record with a numeric id, a title, a 1..3 priority
(1 is the most urgent), a normalised list of tags, an optional due date,
a status (``open`` or ``done``) and a creation date.  All serialisation
to and from the JSON storage format lives here so that the storage layer
never needs to know about field semantics.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable

from .dates import parse_optional_date

# --------------------------------------------------------------------------
# Priorities
# --------------------------------------------------------------------------

PRIORITY_HIGH = 1
PRIORITY_MEDIUM = 2
PRIORITY_LOW = 3

#: Human labels used by the CLI and reports, keyed by numeric priority.
PRIORITY_LABELS: dict[int, str] = {
    PRIORITY_HIGH: "high",
    PRIORITY_MEDIUM: "medium",
    PRIORITY_LOW: "low",
}

#: Inverse mapping, for parsing CLI arguments and legacy files.
LABEL_TO_PRIORITY: dict[str, int] = {v: k for k, v in PRIORITY_LABELS.items()}

#: Priority assigned when the user does not specify one.
DEFAULT_PRIORITY = PRIORITY_MEDIUM

# --------------------------------------------------------------------------
# Statuses
# --------------------------------------------------------------------------

STATUS_OPEN = "open"
STATUS_DONE = "done"
VALID_STATUSES = (STATUS_OPEN, STATUS_DONE)


class TaskValidationError(ValueError):
    """Raised when task fields violate an invariant."""


def priority_label(priority: int) -> str:
    """Human label (``high``/``medium``/``low``) for a numeric priority."""
    try:
        return PRIORITY_LABELS[priority]
    except KeyError:
        raise TaskValidationError(f"unknown priority {priority!r}") from None


def parse_priority(text: str) -> int:
    """Parse a CLI priority argument: a label or a bare digit 1..3."""
    raw = text.strip().lower()
    if raw in LABEL_TO_PRIORITY:
        return LABEL_TO_PRIORITY[raw]
    if raw.isdigit() and int(raw) in PRIORITY_LABELS:
        return int(raw)
    raise TaskValidationError(
        f"invalid priority {text!r}: use high, medium, low or 1..3"
    )


def normalize_tags(tags: Iterable[str]) -> list[str]:
    """Canonicalise a tag collection.

    Tags are stripped, lower-cased, deduplicated (first occurrence wins)
    and empty entries are dropped.  Order of first appearance is kept so
    that user-entered ordering survives round-trips.
    """
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        cleaned = tag.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def split_tag_string(raw: str) -> list[str]:
    """Split a comma-separated CLI/legacy tag string into normalised tags."""
    return normalize_tags(raw.split(","))


@dataclass
class Task:
    """A single todo item.

    Attributes
    ----------
    id:
        Positive integer, unique within one storage file.
    title:
        Non-empty human description.
    priority:
        1 (high) .. 3 (low).  Defaults to :data:`DEFAULT_PRIORITY`.
    tags:
        Normalised lowercase tags (see :func:`normalize_tags`).
    due:
        Optional due date.
    status:
        ``open`` or ``done``.
    created:
        Date the task was created; optional for in-memory tasks, always
        set by the CLI.
    """

    id: int
    title: str
    priority: int = DEFAULT_PRIORITY
    tags: list[str] = field(default_factory=list)
    due: date | None = None
    status: str = STATUS_OPEN
    created: date | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.id, int) or self.id < 1:
            raise TaskValidationError(f"task id must be a positive int, got {self.id!r}")
        self.title = self.title.strip()
        if not self.title:
            raise TaskValidationError("task title must not be empty")
        if self.priority not in PRIORITY_LABELS:
            raise TaskValidationError(f"priority must be 1..3, got {self.priority!r}")
        if self.status not in VALID_STATUSES:
            raise TaskValidationError(f"status must be one of {VALID_STATUSES}, got {self.status!r}")
        self.tags = normalize_tags(self.tags)

    # -- derived ----------------------------------------------------------

    @property
    def is_done(self) -> bool:
        """True when the task has been completed."""
        return self.status == STATUS_DONE

    @property
    def priority_name(self) -> str:
        """The human label for this task's priority."""
        return priority_label(self.priority)

    def has_tag(self, tag: str) -> bool:
        """Case-insensitive single-tag membership test."""
        return tag.strip().lower() in self.tags

    # -- mutation ---------------------------------------------------------

    def mark_done(self) -> None:
        """Transition the task to the ``done`` status (idempotent)."""
        self.status = STATUS_DONE

    def reopen(self) -> None:
        """Transition the task back to ``open`` (idempotent)."""
        self.status = STATUS_OPEN

    # -- serialisation ----------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Plain-JSON representation used by the storage layer."""
        return {
            "id": self.id,
            "title": self.title,
            "priority": self.priority,
            "tags": list(self.tags),
            "due": self.due.isoformat() if self.due else None,
            "status": self.status,
            "created": self.created.isoformat() if self.created else None,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Task":
        """Build a task from a (current-schema) storage record.

        Unknown keys are ignored; missing optional keys fall back to
        their defaults so that hand-edited files stay loadable.
        """
        return cls(
            id=int(raw["id"]),
            title=str(raw["title"]),
            priority=int(raw.get("priority", DEFAULT_PRIORITY)),
            tags=list(raw.get("tags") or []),
            due=parse_optional_date(raw.get("due")),
            status=str(raw.get("status", STATUS_OPEN)),
            created=parse_optional_date(raw.get("created")),
        )
