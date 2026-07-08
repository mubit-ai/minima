"""Pure filtering, searching and sorting over task lists.

Every function here is side-effect free: it takes a list of
:class:`~taskman.models.Task` (plus an explicit ``today`` where time is
involved) and returns a new list.  The CLI composes these primitives;
they are deliberately small so each rule is testable in isolation.
"""

from __future__ import annotations

from datetime import date
from typing import Iterable

from .dates import add_days
from .models import Task, normalize_tags

#: Days ahead (inclusive) that count as "upcoming" in the due buckets.
UPCOMING_WINDOW_DAYS = 7

#: Bucket names produced by :func:`bucket_by_due`, in display order.
DUE_BUCKETS = ("overdue", "today", "upcoming", "later", "unscheduled")


# --------------------------------------------------------------------------
# Predicates
# --------------------------------------------------------------------------

def is_overdue(task: Task, today: date) -> bool:
    """True for an *open* task whose due date is strictly in the past.

    Done tasks are never overdue, and tasks without a due date cannot
    be overdue.  A task due today is not yet overdue.
    """
    return task.due is not None and task.due < today and not task.is_done


def is_due_today(task: Task, today: date) -> bool:
    """True for an open task due exactly on ``today``."""
    return task.due == today and not task.is_done


# --------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------

def filter_status(tasks: Iterable[Task], status: str) -> list[Task]:
    """Keep tasks with the given status; ``"all"`` disables the filter."""
    if status == "all":
        return list(tasks)
    return [t for t in tasks if t.status == status]


def filter_priority(tasks: Iterable[Task], lo: int, hi: int) -> list[Task]:
    """Keep tasks whose priority is within ``lo..hi`` inclusive.

    Remember that *lower* numbers are *more* urgent: ``lo=1, hi=2``
    selects high- and medium-priority tasks.
    """
    return [t for t in tasks if lo <= t.priority <= hi]


def filter_tags(tasks: Iterable[Task], tags: Iterable[str]) -> list[Task]:
    """Keep tasks carrying **all** of the requested tags (AND semantics).

    Requested tags are normalised the same way stored tags are, so the
    match is case-insensitive.  An empty request matches every task.
    """
    wanted = normalize_tags(tags)
    if not wanted:
        return list(tasks)
    return [t for t in tasks if all(tag in t.tags for tag in wanted)]


def filter_overdue(tasks: Iterable[Task], today: date) -> list[Task]:
    """Keep only tasks that are overdue as of ``today``."""
    return [t for t in tasks if is_overdue(t, today)]


def due_within(tasks: Iterable[Task], days: int, today: date) -> list[Task]:
    """Open tasks due between ``today`` and ``today + days`` inclusive.

    ``days=0`` selects exactly today's open tasks.  Tasks without a due
    date, already-overdue tasks and done tasks are excluded.
    """
    horizon = add_days(today, days)
    return [
        t
        for t in tasks
        if t.due is not None
        and not t.is_done
        and today <= t.due <= horizon
    ]


# --------------------------------------------------------------------------
# Free-text search
# --------------------------------------------------------------------------

def matches_text(task: Task, needle: str) -> bool:
    """Case-insensitive substring match against title and tags."""
    lowered = needle.strip().lower()
    if not lowered:
        return True
    if lowered in task.title.lower():
        return True
    return any(lowered in tag for tag in task.tags)


def search(tasks: Iterable[Task], needle: str) -> list[Task]:
    """Keep tasks matching the free-text ``needle`` (see matches_text)."""
    return [t for t in tasks if matches_text(t, needle)]


# --------------------------------------------------------------------------
# Due buckets
# --------------------------------------------------------------------------

def bucket_by_due(tasks: Iterable[Task], today: date) -> dict[str, list[Task]]:
    """Group *open* tasks into agenda buckets relative to ``today``.

    Buckets (see :data:`DUE_BUCKETS`):

    - ``overdue``      due strictly before today
    - ``today``        due exactly today
    - ``upcoming``     due within the next :data:`UPCOMING_WINDOW_DAYS`
                       days, inclusive of the window's last day
    - ``later``        due beyond the upcoming window
    - ``unscheduled``  no due date

    Done tasks are not part of the agenda and are skipped entirely.
    """
    horizon = add_days(today, UPCOMING_WINDOW_DAYS)
    buckets: dict[str, list[Task]] = {name: [] for name in DUE_BUCKETS}
    for task in tasks:
        if task.is_done:
            continue
        if task.due is None:
            buckets["unscheduled"].append(task)
        elif task.due < today:
            buckets["overdue"].append(task)
        elif task.due == today:
            buckets["today"].append(task)
        elif task.due <= horizon:
            buckets["upcoming"].append(task)
        else:
            buckets["later"].append(task)
    return buckets


# --------------------------------------------------------------------------
# Sorting
# --------------------------------------------------------------------------

#: Legal values for the ``--sort`` CLI flag.
SORT_KEYS = ("id", "due", "priority", "created")

# A date far in the future so tasks without a due date sort last.
_DATE_MAX = date(9999, 12, 31)


def sort_tasks(tasks: Iterable[Task], key: str = "id") -> list[Task]:
    """Return tasks ordered by the given key (stable, ties by id).

    - ``id``        ascending numeric id (insertion order)
    - ``due``       soonest due date first; undated tasks last
    - ``priority``  most urgent (1) first
    - ``created``   oldest first; unknown creation dates last
    """
    items = list(tasks)
    if key == "id":
        return sorted(items, key=lambda t: t.id)
    if key == "due":
        return sorted(items, key=lambda t: (t.due or _DATE_MAX, t.id))
    if key == "priority":
        return sorted(items, key=lambda t: (t.priority, t.id))
    if key == "created":
        return sorted(items, key=lambda t: (t.created or _DATE_MAX, t.id))
    raise ValueError(f"unknown sort key {key!r}; expected one of {SORT_KEYS}")
