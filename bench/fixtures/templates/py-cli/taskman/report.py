"""Rendering: task tables, summary statistics and the full report.

All functions here are pure string/dict producers — printing is left to
the CLI layer.  Anything time-dependent takes ``today`` explicitly.
"""

from __future__ import annotations

from datetime import date
from typing import Iterable

from .dates import humanize_delta, iso
from .models import PRIORITY_LABELS, STATUS_DONE, STATUS_OPEN, Task
from .query import DUE_BUCKETS, bucket_by_due, is_overdue

# --------------------------------------------------------------------------
# Table rendering
# --------------------------------------------------------------------------

#: Column headers for the list table, in display order.
TABLE_COLUMNS = ("ID", "PRI", "TITLE", "TAGS", "DUE", "WHEN", "ST")

#: Titles longer than this are truncated with an ellipsis in tables.
MAX_TITLE_WIDTH = 40


def _truncate(text: str, width: int) -> str:
    """Clip ``text`` to ``width`` characters, appending ``…`` if clipped."""
    if len(text) <= width:
        return text
    return text[: width - 1] + "…"


def _table_row(task: Task, today: date) -> tuple[str, ...]:
    """One rendered table row (all cells as strings)."""
    return (
        str(task.id),
        task.priority_name,
        _truncate(task.title, MAX_TITLE_WIDTH),
        ",".join(task.tags) if task.tags else "-",
        iso(task.due),
        humanize_delta(task.due, today),
        "✔" if task.is_done else "·",
    )


def render_table(tasks: Iterable[Task], today: date) -> str:
    """Render tasks as an aligned, monospace-friendly text table.

    Returns the placeholder string ``"(no tasks)"`` for an empty list so
    the CLI always has something sensible to print.
    """
    rows = [_table_row(t, today) for t in tasks]
    if not rows:
        return "(no tasks)"
    widths = [
        max(len(TABLE_COLUMNS[i]), *(len(r[i]) for r in rows))
        for i in range(len(TABLE_COLUMNS))
    ]
    def fmt(cells: tuple[str, ...]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells)).rstrip()
    header = fmt(TABLE_COLUMNS)
    divider = "-" * len(header)
    return "\n".join([header, divider] + [fmt(r) for r in rows])


# --------------------------------------------------------------------------
# Agenda view
# --------------------------------------------------------------------------

#: Section headings for the agenda, keyed by bucket name.
AGENDA_HEADINGS = {
    "overdue": "OVERDUE",
    "today": "TODAY",
    "upcoming": "UPCOMING",
    "later": "LATER",
    "unscheduled": "UNSCHEDULED",
}


def render_agenda(tasks: Iterable[Task], today: date) -> str:
    """Render the ``agenda`` command: open tasks grouped by due bucket.

    Each non-empty bucket becomes a section with one line per task
    (``#id  title  (when)``), soonest bucket first.  Buckets with no
    tasks are omitted; a fully empty agenda renders a placeholder.
    """
    buckets = bucket_by_due(tasks, today)
    sections: list[str] = []
    for name in DUE_BUCKETS:
        entries = buckets[name]
        if not entries:
            continue
        lines = [f"{AGENDA_HEADINGS[name]}:"]
        for task in entries:
            lines.append(f"  #{task.id}  {task.title}  ({humanize_delta(task.due, today)})")
        sections.append("\n".join(lines))
    if not sections:
        return "(nothing on the agenda)"
    return "\n\n".join(sections)


# --------------------------------------------------------------------------
# Summary statistics
# --------------------------------------------------------------------------

def summary(tasks: Iterable[Task], today: date) -> dict[str, object]:
    """Aggregate counters for the report header.

    Returns a dict with: ``total``, ``open``, ``done``, ``overdue``,
    ``unscheduled`` (open tasks without a due date) and
    ``completion_rate`` (done / total, ``0.0`` for an empty list).
    """
    items = list(tasks)
    total = len(items)
    done = sum(1 for t in items if t.status == STATUS_DONE)
    open_count = sum(1 for t in items if t.status == STATUS_OPEN)
    overdue = sum(1 for t in items if is_overdue(t, today))
    unscheduled = sum(1 for t in items if t.due is None and not t.is_done)
    rate = (done / total) if total else 0.0
    return {
        "total": total,
        "open": open_count,
        "done": done,
        "overdue": overdue,
        "unscheduled": unscheduled,
        "completion_rate": round(rate, 3),
    }


def group_by_priority(tasks: Iterable[Task]) -> list[dict[str, object]]:
    """Task counts per priority band, most urgent first.

    Each row is ``{"label", "count", "percent"}`` where ``percent`` is
    the share of **all** listed tasks in that band (one decimal place).
    Bands with zero tasks are still included so reports have a stable
    shape.  Percentages therefore always sum to ~100 for non-empty
    inputs.
    """
    items = list(tasks)
    total = len(items)
    rows: list[dict[str, object]] = []
    for priority, label in sorted(PRIORITY_LABELS.items()):
        count = sum(1 for t in items if t.priority == priority)
        percent = round(100.0 * count / total, 1) if total else 0.0
        rows.append({"label": label, "count": count, "percent": percent})
    return rows


def tag_histogram(tasks: Iterable[Task], top: int | None = None) -> list[tuple[str, int]]:
    """Tag usage counts, most used first (alphabetical tie-break).

    Every task contributes one count per distinct tag it carries.  When
    ``top`` is given, only the ``top`` most frequent tags are returned.
    """
    counts: dict[str, int] = {}
    for task in tasks:
        for tag in task.tags:
            counts[tag] = counts.get(tag, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return ordered[:top] if top is not None else ordered


# --------------------------------------------------------------------------
# Full report
# --------------------------------------------------------------------------

def render_summary(stats: dict[str, object]) -> str:
    """Render the summary counters as aligned ``key: value`` lines."""
    pct = f"{float(stats['completion_rate']) * 100:.1f}%"
    lines = [
        f"total:       {stats['total']}",
        f"open:        {stats['open']}",
        f"done:        {stats['done']}",
        f"overdue:     {stats['overdue']}",
        f"unscheduled: {stats['unscheduled']}",
        f"completed:   {pct}",
    ]
    return "\n".join(lines)


def render_priority_breakdown(rows: list[dict[str, object]]) -> str:
    """Render the per-priority rows as ``label  count  percent`` lines."""
    lines = []
    for row in rows:
        lines.append(f"{row['label']:<8}{row['count']:>4}  {row['percent']:>5.1f}%")
    return "\n".join(lines)


def render_tag_histogram(pairs: list[tuple[str, int]]) -> str:
    """Render tag counts as ``tag  count`` lines (or a placeholder)."""
    if not pairs:
        return "(no tags)"
    width = max(len(tag) for tag, _ in pairs)
    return "\n".join(f"{tag.ljust(width)}  {count}" for tag, count in pairs)


def render_report(tasks: Iterable[Task], today: date, top_tags: int = 5) -> str:
    """The full ``taskman report`` output: summary, priorities, tags."""
    items = list(tasks)
    sections = [
        "== summary ==",
        render_summary(summary(items, today)),
        "",
        "== by priority ==",
        render_priority_breakdown(group_by_priority(items)),
        "",
        f"== top tags (max {top_tags}) ==",
        render_tag_histogram(tag_histogram(items, top=top_tags)),
    ]
    return "\n".join(sections)
