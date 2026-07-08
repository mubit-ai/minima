"""Tests for taskman.query — filters, search, buckets, sorting."""

import pytest

from taskman.query import (
    bucket_by_due,
    due_within,
    filter_overdue,
    filter_priority,
    filter_status,
    filter_tags,
    is_due_today,
    is_overdue,
    search,
    sort_tasks,
)

from .conftest import TODAY, make_task, rel


def ids(tasks):
    return [t.id for t in tasks]


# -- predicates -------------------------------------------------------------

def test_is_overdue_rules():
    assert is_overdue(make_task(due=rel(-2)), TODAY)
    assert not is_overdue(make_task(due=rel(-2), status="done"), TODAY)
    assert not is_overdue(make_task(due=None), TODAY)
    assert not is_overdue(make_task(due=TODAY), TODAY)  # due today != overdue


def test_is_due_today():
    assert is_due_today(make_task(due=TODAY), TODAY)
    assert not is_due_today(make_task(due=rel(1)), TODAY)
    assert not is_due_today(make_task(due=TODAY, status="done"), TODAY)


# -- filters ----------------------------------------------------------------

def test_filter_status():
    tasks = [make_task(id=1), make_task(id=2, status="done"), make_task(id=3)]
    assert ids(filter_status(tasks, "open")) == [1, 3]
    assert ids(filter_status(tasks, "done")) == [2]
    assert ids(filter_status(tasks, "all")) == [1, 2, 3]


def test_filter_priority_inclusive_range():
    tasks = [make_task(id=n, priority=n) for n in (1, 2, 3)]
    assert ids(filter_priority(tasks, 1, 2)) == [1, 2]
    assert ids(filter_priority(tasks, 2, 2)) == [2]
    assert ids(filter_priority(tasks, 1, 3)) == [1, 2, 3]


def test_filter_tags_single_tag_case_insensitive():
    tasks = [
        make_task(id=1, tags=("home", "errand")),
        make_task(id=2, tags=("work",)),
        make_task(id=3, tags=("home",)),
    ]
    assert ids(filter_tags(tasks, ["Home"])) == [1, 3]
    assert ids(filter_tags(tasks, ["work"])) == [2]
    assert ids(filter_tags(tasks, ["nosuch"])) == []
    # An empty (or blank) request disables the filter entirely.
    assert ids(filter_tags(tasks, [])) == [1, 2, 3]
    assert ids(filter_tags(tasks, ["", "  "])) == [1, 2, 3]


def test_filter_overdue():
    tasks = [
        make_task(id=1, due=rel(-3)),
        make_task(id=2, due=rel(2)),
        make_task(id=3, due=rel(-1), status="done"),
    ]
    assert ids(filter_overdue(tasks, TODAY)) == [1]


def test_due_within_window():
    tasks = [
        make_task(id=1, due=rel(1)),
        make_task(id=2, due=rel(3)),
        make_task(id=3, due=rel(10)),
        make_task(id=4, due=rel(-1)),
        make_task(id=5, due=None),
        make_task(id=6, due=rel(2), status="done"),
    ]
    assert ids(due_within(tasks, 7, TODAY)) == [1, 2]


# -- search -------------------------------------------------------------------

def test_search_matches_title_substring():
    tasks = [
        make_task(id=1, title="Buy milk"),
        make_task(id=2, title="Call the plumber"),
    ]
    assert ids(search(tasks, "milk")) == [1]
    assert ids(search(tasks, "plumb")) == [2]
    assert ids(search(tasks, "zzz")) == []


def test_search_matches_tags_and_blank_needle():
    tasks = [
        make_task(id=1, tags=("errands",)),
        make_task(id=2, tags=("work",)),
    ]
    assert ids(search(tasks, "errand")) == [1]
    # A blank needle matches everything.
    assert ids(search(tasks, "")) == [1, 2]
    assert ids(search(tasks, "   ")) == [1, 2]


# -- buckets ------------------------------------------------------------------

def test_bucket_by_due_groups_open_tasks():
    tasks = [
        make_task(id=1, due=rel(-3)),
        make_task(id=2, due=TODAY),
        make_task(id=3, due=rel(2)),
        make_task(id=4, due=rel(5)),
        make_task(id=5, due=rel(12)),
        make_task(id=6, due=None),
    ]
    buckets = bucket_by_due(tasks, TODAY)
    assert ids(buckets["overdue"]) == [1]
    assert ids(buckets["today"]) == [2]
    assert ids(buckets["upcoming"]) == [3, 4]
    assert ids(buckets["later"]) == [5]
    assert ids(buckets["unscheduled"]) == [6]


def test_bucket_by_due_skips_done_tasks():
    tasks = [
        make_task(id=1, due=rel(-3), status="done"),
        make_task(id=2, due=None, status="done"),
        make_task(id=3, due=rel(2)),
    ]
    buckets = bucket_by_due(tasks, TODAY)
    assert ids(buckets["overdue"]) == []
    assert ids(buckets["unscheduled"]) == []
    assert ids(buckets["upcoming"]) == [3]


# -- sorting ------------------------------------------------------------------

def test_sort_by_due_puts_undated_last():
    tasks = [
        make_task(id=1, due=None),
        make_task(id=2, due=rel(5)),
        make_task(id=3, due=rel(1)),
    ]
    assert ids(sort_tasks(tasks, "due")) == [3, 2, 1]


def test_sort_by_priority_breaks_ties_by_id():
    tasks = [
        make_task(id=3, priority=2),
        make_task(id=1, priority=2),
        make_task(id=2, priority=1),
    ]
    assert ids(sort_tasks(tasks, "priority")) == [2, 1, 3]


def test_sort_by_created_and_unknown_key():
    tasks = [
        make_task(id=1, created=rel(-1)),
        make_task(id=2, created=rel(-10)),
        make_task(id=3, created=None),
    ]
    assert ids(sort_tasks(tasks, "created")) == [2, 1, 3]
    with pytest.raises(ValueError):
        sort_tasks(tasks, "flavour")
