"""Shared fixtures/helpers for the taskman test suite.

All tests pin time explicitly (via arguments or the ``--today`` CLI
flag) so the suite is fully deterministic.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from taskman.models import Task

#: The frozen reference date used across the suite.
TODAY = date(2026, 3, 15)


def rel(days: int) -> date:
    """A date ``days`` away from the frozen TODAY (negative = past)."""
    return TODAY + timedelta(days=days)


def make_task(
    id: int = 1,
    title: str = "Untitled task",
    priority: int = 2,
    tags: tuple[str, ...] = (),
    due: date | None = None,
    status: str = "open",
    created: date | None = date(2026, 3, 1),
) -> Task:
    """Task factory with explicit, deterministic defaults."""
    return Task(
        id=id,
        title=title,
        priority=priority,
        tags=list(tags),
        due=due,
        status=status,
        created=created,
    )


@pytest.fixture()
def store_path(tmp_path):
    """A per-test path for the JSON storage file."""
    return tmp_path / "tasks.json"
