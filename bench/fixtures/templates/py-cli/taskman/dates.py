"""Date helpers with an injectable "today".

Every piece of time-dependent logic in taskman receives ``today`` as an
explicit :class:`datetime.date`.  The single place where "now" enters the
program is :func:`resolve_today`, which can be overridden either by an
explicit CLI flag (``--today``) or by the ``TASKMAN_TODAY`` environment
variable.  This keeps the whole code base deterministic under test.
"""

from __future__ import annotations

import os
import re
from datetime import date, timedelta

#: Environment variable that pins "today" (ISO format ``YYYY-MM-DD``).
ENV_TODAY = "TASKMAN_TODAY"

_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DateParseError(ValueError):
    """Raised when a user-supplied date string cannot be parsed."""


def parse_date(text: str) -> date:
    """Parse a strict ISO ``YYYY-MM-DD`` string into a :class:`date`.

    Raises :class:`DateParseError` with a friendly message on any
    malformed input (wrong shape, impossible calendar day, etc.).
    """
    raw = text.strip()
    if not _ISO_RE.match(raw):
        raise DateParseError(f"invalid date {text!r}: expected YYYY-MM-DD")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:  # e.g. 2024-02-30
        raise DateParseError(f"invalid date {text!r}: {exc}") from exc


def parse_optional_date(text: str | None) -> date | None:
    """Like :func:`parse_date` but maps ``None``/empty string to ``None``."""
    if text is None or not text.strip():
        return None
    return parse_date(text)


def resolve_today(explicit: date | None = None) -> date:
    """Return the effective "today".

    Precedence: an explicit argument (from ``--today``) wins, then the
    ``TASKMAN_TODAY`` environment variable, then the real system clock.
    """
    if explicit is not None:
        return explicit
    env = os.environ.get(ENV_TODAY)
    if env:
        return parse_date(env)
    return date.today()


def add_days(day: date, n: int) -> date:
    """Return ``day`` shifted by ``n`` calendar days (may be negative)."""
    return day + timedelta(days=n)


def days_between(start: date, end: date) -> int:
    """Whole days from ``start`` to ``end`` (positive when end is later)."""
    return (end - start).days


def iso(day: date | None) -> str:
    """ISO string for a date, or ``"-"`` for unset dates (table cells)."""
    return day.isoformat() if day is not None else "-"


def humanize_delta(due: date | None, today: date) -> str:
    """Short human description of a due date relative to ``today``.

    Examples: ``"today"``, ``"tomorrow"``, ``"in 5d"``, ``"3d late"``.
    Unset due dates render as ``"-"``.
    """
    if due is None:
        return "-"
    delta = days_between(today, due)
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if delta > 1:
        return f"in {delta}d"
    if delta == -1:
        return "yesterday"
    return f"{-delta}d late"
