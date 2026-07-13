"""Schema migrations for the on-disk taskman JSON format.

The storage file carries a top-level ``"schema"`` integer.  Older files
are upgraded in memory, one version at a time, before task records are
handed to :class:`taskman.models.Task`.  The chain is:

    v1  — the original format: ``priority`` was a label string
          (``"high"``/``"medium"``/``"low"``), ``tags`` was a single
          comma-separated string, completion was a ``"done"`` boolean.
    v2  — ``priority`` became an int 1..3 and ``tags`` a list of strings;
          completion stayed a ``"done"`` boolean.
    v3  — current: the ``"done"`` boolean was replaced by a ``"status"``
          string (``"open"``/``"done"``).

Each ``_upgrade_vN`` function takes the whole document dict for schema N
and returns a new document dict for schema N+1.  Migration never mutates
its input, so a failed save cannot corrupt what the caller loaded.
"""

from __future__ import annotations

from typing import Any

from .models import (
    DEFAULT_PRIORITY,
    LABEL_TO_PRIORITY,
    STATUS_DONE,
    STATUS_OPEN,
    split_tag_string,
)

#: The schema version this code base reads and writes natively.
CURRENT_SCHEMA = 3


class MigrationError(ValueError):
    """Raised when a document cannot be upgraded to the current schema."""


def _coerce_priority_label(raw: Any) -> int:
    """Map a v1 priority label to its numeric value (unknown → default)."""
    if isinstance(raw, str) and raw.strip().lower() in LABEL_TO_PRIORITY:
        return LABEL_TO_PRIORITY[raw.strip().lower()]
    return DEFAULT_PRIORITY


def _upgrade_v1(doc: dict[str, Any]) -> dict[str, Any]:
    """Upgrade a schema-1 document to schema 2.

    Converts each record's ``priority`` label to an int and splits the
    comma-separated ``tags`` string into a normalised list.  All other
    fields (``id``, ``title``, ``due``, ``done``, ``created``) carry
    over unchanged.
    """
    records = []
    for rec in doc.get("tasks", []):
        records.append(
            {
                "id": int(rec["id"]),
                "title": rec["title"],
                "priority": _coerce_priority_label(rec.get("priority")),
                "tags": split_tag_string(str(rec.get("tags") or "")),
                "due": rec.get("due"),
                "done": bool(rec.get("done", False)),
                "created": rec.get("created"),
            }
        )
    return {"schema": 2, "tasks": records}


def _upgrade_v2(doc: dict[str, Any]) -> dict[str, Any]:
    """Upgrade a schema-2 document to schema 3.

    Replaces the boolean ``done`` flag with the ``status`` string and
    drops the old key.  Everything else carries over unchanged.
    """
    records = []
    for rec in doc.get("tasks", []):
        upgraded = dict(rec)
        done = bool(upgraded.pop("done", False))
        upgraded["status"] = STATUS_DONE if done else STATUS_OPEN
        records.append(upgraded)
    return {"schema": 3, "tasks": records}


#: Upgrade steps keyed by the schema version they consume.
_UPGRADES = {
    1: _upgrade_v1,
    2: _upgrade_v2,
}


def migrate(doc: dict[str, Any]) -> dict[str, Any]:
    """Upgrade ``doc`` to :data:`CURRENT_SCHEMA`, one step at a time.

    Documents already at the current schema are returned as-is.  Raises
    :class:`MigrationError` for unknown (future or nonsensical) versions.
    """
    version = doc.get("schema")
    if not isinstance(version, int):
        raise MigrationError(f"missing or invalid schema marker: {version!r}")
    if version > CURRENT_SCHEMA or version < 1:
        raise MigrationError(
            f"unsupported schema {version} (this build reads up to {CURRENT_SCHEMA})"
        )
    while version < CURRENT_SCHEMA:
        doc = _UPGRADES[version](doc)
        version = doc["schema"]
    return doc
