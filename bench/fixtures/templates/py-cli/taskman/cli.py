"""Command-line interface for taskman.

Usage overview::

    taskman --file tasks.json add "Buy milk" --priority high --tags home,errand --due 2026-07-10
    taskman --file tasks.json list --tag home --due-within 7 --sort due
    taskman --file tasks.json done 3
    taskman --file tasks.json rm 3
    taskman --file tasks.json report --top 3

Global flags:

``--file``   storage path (default: ``TASKMAN_FILE`` env or ``~/.taskman.json``)
``--today``  pin "today" for all date logic (default: ``TASKMAN_TODAY`` env
             or the system clock) — mainly for tests and reproductions.

Exit codes: 0 success, 1 domain error (bad input, unknown id), 2 argparse
usage error.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Sequence

from . import __version__
from .dates import DateParseError, parse_date, resolve_today
from .models import (
    Task,
    TaskValidationError,
    parse_priority,
    split_tag_string,
)
from .query import (
    SORT_KEYS,
    due_within,
    filter_overdue,
    filter_priority,
    filter_status,
    filter_tags,
    search,
    sort_tasks,
)
from .report import render_agenda, render_report, render_table
from .storage import StorageError, Store

#: Environment variable naming the default storage file.
ENV_FILE = "TASKMAN_FILE"

_DEFAULT_FILE = "~/.taskman.json"


class CliError(Exception):
    """User-facing error: printed to stderr, exits with status 1."""


# --------------------------------------------------------------------------
# Parser construction
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    """Construct the argparse tree for all subcommands."""
    parser = argparse.ArgumentParser(
        prog="taskman",
        description="A small file-backed task manager.",
    )
    parser.add_argument("--version", action="version", version=f"taskman {__version__}")
    parser.add_argument(
        "--file",
        default=None,
        help=f"storage file (default: ${ENV_FILE} or {_DEFAULT_FILE})",
    )
    parser.add_argument(
        "--today",
        default=None,
        metavar="YYYY-MM-DD",
        help="pin 'today' for due-date logic (default: $TASKMAN_TODAY or the clock)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="add a new task")
    p_add.add_argument("title", help="task description")
    p_add.add_argument("--priority", "-p", default=None, help="high|medium|low or 1..3")
    p_add.add_argument("--tags", default="", help="comma-separated tags")
    p_add.add_argument("--due", default=None, metavar="YYYY-MM-DD", help="due date")

    p_list = sub.add_parser("list", help="list tasks with optional filters")
    p_list.add_argument(
        "--status",
        choices=("open", "done", "all"),
        default="open",
        help="which statuses to show (default: open)",
    )
    p_list.add_argument(
        "--tag",
        action="append",
        default=[],
        help="require this tag (repeatable; all given tags must match)",
    )
    p_list.add_argument("--priority-min", default=None, help="most urgent priority to include")
    p_list.add_argument("--priority-max", default=None, help="least urgent priority to include")
    p_list.add_argument("--due-within", type=int, default=None, metavar="DAYS",
                        help="only tasks due in the next DAYS days")
    p_list.add_argument("--overdue", action="store_true", help="only overdue tasks")
    p_list.add_argument("--search", default=None, help="free-text match on title/tags")
    p_list.add_argument("--sort", choices=SORT_KEYS, default="id", help="sort order")

    sub.add_parser("agenda", help="open tasks grouped by due-date bucket")

    p_done = sub.add_parser("done", help="mark a task as completed")
    p_done.add_argument("id", type=int, help="task id")

    p_rm = sub.add_parser("rm", help="delete a task")
    p_rm.add_argument("id", type=int, help="task id")

    p_report = sub.add_parser("report", help="summary statistics")
    p_report.add_argument("--top", type=int, default=5, help="how many tags to show")

    return parser


def _store_from_args(args: argparse.Namespace) -> Store:
    """Resolve the storage path: --file flag, then env, then home default."""
    path = args.file or os.environ.get(ENV_FILE) or os.path.expanduser(_DEFAULT_FILE)
    return Store(path)


def _today_from_args(args: argparse.Namespace):
    """Resolve 'today' honouring the --today flag and TASKMAN_TODAY."""
    explicit = parse_date(args.today) if args.today else None
    return resolve_today(explicit)


# --------------------------------------------------------------------------
# Command handlers
# --------------------------------------------------------------------------

def cmd_add(args: argparse.Namespace) -> int:
    """Handle ``taskman add``: create, persist and echo the new task."""
    store = _store_from_args(args)
    today = _today_from_args(args)
    tasks = store.load()
    fields: dict[str, object] = {
        "id": store.next_id(tasks),
        "title": args.title,
        "tags": split_tag_string(args.tags),
        "due": parse_date(args.due) if args.due else None,
        "created": today,
    }
    if args.priority is not None:
        fields["priority"] = parse_priority(args.priority)
    task = Task(**fields)  # type: ignore[arg-type]
    tasks.append(task)
    store.save(tasks)
    print(f"added #{task.id}: {task.title} [{task.priority_name}]")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    """Handle ``taskman list``: apply filters, sort, render the table."""
    store = _store_from_args(args)
    today = _today_from_args(args)
    tasks = store.load()
    tasks = filter_status(tasks, args.status)
    if args.tag:
        tasks = filter_tags(tasks, args.tag)
    if args.priority_min is not None or args.priority_max is not None:
        lo = parse_priority(args.priority_min) if args.priority_min else 1
        hi = parse_priority(args.priority_max) if args.priority_max else 3
        tasks = filter_priority(tasks, lo, hi)
    if args.overdue:
        tasks = filter_overdue(tasks, today)
    if args.due_within is not None:
        tasks = due_within(tasks, args.due_within, today)
    if args.search:
        tasks = search(tasks, args.search)
    tasks = sort_tasks(tasks, args.sort)
    print(render_table(tasks, today))
    return 0


def cmd_agenda(args: argparse.Namespace) -> int:
    """Handle ``taskman agenda``: bucketed view of open tasks."""
    store = _store_from_args(args)
    today = _today_from_args(args)
    tasks = store.load()
    print(render_agenda(tasks, today))
    return 0


def cmd_done(args: argparse.Namespace) -> int:
    """Handle ``taskman done``: mark one task completed and persist."""
    store = _store_from_args(args)
    tasks = store.load()
    task = store.find(tasks, args.id)
    task.mark_done()
    store.save(tasks)
    print(f"done #{task.id}: {task.title}")
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    """Handle ``taskman rm``: delete one task and persist."""
    store = _store_from_args(args)
    tasks = store.load()
    task = store.find(tasks, args.id)
    remaining = store.remove(tasks, args.id)
    store.save(remaining)
    print(f"removed #{task.id}: {task.title}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    """Handle ``taskman report``: print the aggregate report."""
    store = _store_from_args(args)
    today = _today_from_args(args)
    tasks = store.load()
    print(render_report(tasks, today, top_tags=args.top))
    return 0


_HANDLERS = {
    "add": cmd_add,
    "list": cmd_list,
    "agenda": cmd_agenda,
    "done": cmd_done,
    "rm": cmd_rm,
    "report": cmd_report,
}


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; returns the process exit code."""
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    handler = _HANDLERS[args.command]
    try:
        return handler(args)
    except (CliError, DateParseError, TaskValidationError, StorageError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
