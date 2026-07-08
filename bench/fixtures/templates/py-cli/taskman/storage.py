"""JSON-file persistence for tasks.

The storage format is a single JSON document::

    {"schema": 3, "tasks": [ {...}, ... ]}

Loading tolerates older schema versions (see :mod:`taskman.migrations`)
and always returns fully-validated :class:`~taskman.models.Task`
objects.  Saving is atomic: the document is written to a sibling
temporary file which is then renamed over the target, so a crash can
never leave a half-written file behind.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .migrations import CURRENT_SCHEMA, MigrationError, migrate
from .models import Task, TaskValidationError


class StorageError(Exception):
    """Raised for unreadable, unparsable or invalid storage files."""


class Store:
    """A task collection persisted in one JSON file."""

    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    # -- loading ----------------------------------------------------------

    def load(self) -> list[Task]:
        """Read, migrate and validate all tasks.

        A missing file is treated as an empty collection so that the
        first ``taskman add`` works without a separate init step.
        """
        if not self.path.exists():
            return []
        try:
            text = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise StorageError(f"cannot read {self.path}: {exc}") from exc
        try:
            doc = json.loads(text)
        except json.JSONDecodeError as exc:
            raise StorageError(f"{self.path} is not valid JSON: {exc}") from exc
        if not isinstance(doc, dict):
            raise StorageError(f"{self.path}: top-level value must be an object")
        try:
            doc = migrate(doc)
        except MigrationError as exc:
            raise StorageError(f"{self.path}: {exc}") from exc
        records = doc.get("tasks")
        if not isinstance(records, list):
            raise StorageError(f"{self.path}: 'tasks' must be a list")
        tasks: list[Task] = []
        for i, rec in enumerate(records):
            try:
                tasks.append(Task.from_dict(rec))
            except (KeyError, TaskValidationError, ValueError) as exc:
                raise StorageError(f"{self.path}: task #{i} invalid: {exc}") from exc
        return tasks

    # -- saving -----------------------------------------------------------

    def save(self, tasks: list[Task]) -> None:
        """Atomically write all tasks at the current schema version."""
        doc = {
            "schema": CURRENT_SCHEMA,
            "tasks": [t.to_dict() for t in tasks],
        }
        payload = json.dumps(doc, indent=2, sort_keys=False) + "\n"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp_name, self.path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    # -- convenience ------------------------------------------------------

    def next_id(self, tasks: list[Task]) -> int:
        """Smallest id strictly greater than every existing id (1-based)."""
        return max((t.id for t in tasks), default=0) + 1

    def find(self, tasks: list[Task], task_id: int) -> Task:
        """Return the task with ``task_id`` or raise :class:`StorageError`."""
        for task in tasks:
            if task.id == task_id:
                return task
        raise StorageError(f"no task with id {task_id}")

    def remove(self, tasks: list[Task], task_id: int) -> list[Task]:
        """Return a new list without ``task_id`` (raises if absent)."""
        self.find(tasks, task_id)  # existence check
        return [t for t in tasks if t.id != task_id]
