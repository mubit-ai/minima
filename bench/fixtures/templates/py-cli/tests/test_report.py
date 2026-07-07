"""Tests for taskman.report — tables, summary stats, report sections."""

from taskman.report import (
    group_by_priority,
    render_agenda,
    render_report,
    render_table,
    summary,
    tag_histogram,
)

from .conftest import TODAY, make_task, rel


def test_render_table_empty_placeholder():
    assert render_table([], TODAY) == "(no tasks)"


def test_render_table_cells():
    tasks = [
        make_task(id=1, title="Buy milk", priority=1, tags=("home", "errand"), due=rel(1)),
        make_task(id=2, title="File taxes", priority=3, status="done"),
    ]
    out = render_table(tasks, TODAY)
    lines = out.splitlines()
    assert lines[0].startswith("ID")
    assert "TITLE" in lines[0] and "DUE" in lines[0]
    assert "Buy milk" in out
    assert "home,errand" in out
    assert rel(1).isoformat() in out
    assert "tomorrow" in out
    assert "✔" in out and "·" in out
    # Long titles are truncated with an ellipsis.
    long_title = "Review the quarterly infrastructure budget spreadsheet carefully"
    out = render_table([make_task(title=long_title)], TODAY)
    assert "…" in out
    assert long_title not in out


def test_render_agenda_sections():
    tasks = [
        make_task(id=1, title="Late thing", due=rel(-2)),
        make_task(id=2, title="Near thing", due=rel(3)),
        make_task(id=3, title="Far thing", due=rel(20)),
        make_task(id=4, title="Whenever", due=None),
        make_task(id=5, title="Done thing", due=rel(1), status="done"),
    ]
    out = render_agenda(tasks, TODAY)
    assert out.index("OVERDUE:") < out.index("UPCOMING:") < out.index("LATER:")
    assert "UNSCHEDULED:" in out
    assert "TODAY:" not in out  # empty buckets are omitted
    assert "#1  Late thing  (2d late)" in out
    assert "Done thing" not in out
    assert render_agenda([], TODAY) == "(nothing on the agenda)"


def test_summary_counts():
    tasks = [
        make_task(id=1, due=rel(-2)),                    # open, overdue
        make_task(id=2, due=rel(3)),                     # open, scheduled
        make_task(id=3, due=None),                       # open, unscheduled
        make_task(id=4, due=None, status="done"),        # done
    ]
    stats = summary(tasks, TODAY)
    assert stats["total"] == 4
    assert stats["open"] == 3
    assert stats["done"] == 1
    assert stats["overdue"] == 1
    assert stats["unscheduled"] == 1
    assert stats["completion_rate"] == 0.25


def test_summary_empty():
    stats = summary([], TODAY)
    assert stats["total"] == 0
    assert stats["overdue"] == 0
    assert stats["completion_rate"] == 0.0


def test_group_by_priority_counts_and_shape():
    tasks = [
        make_task(id=1, priority=1),
        make_task(id=2, priority=1),
        make_task(id=3, priority=2),
        make_task(id=4, priority=3),
    ]
    rows = group_by_priority(tasks)
    assert [r["label"] for r in rows] == ["high", "medium", "low"]
    assert [r["count"] for r in rows] == [2, 1, 1]
    assert [r["percent"] for r in rows] == [50.0, 25.0, 25.0]


def test_group_by_priority_stable_shape():
    rows = group_by_priority([make_task(priority=2)])
    assert [r["count"] for r in rows] == [0, 1, 0]
    assert [r["percent"] for r in rows] == [0.0, 100.0, 0.0]
    empty = group_by_priority([])
    assert [r["count"] for r in empty] == [0, 0, 0]
    assert [r["percent"] for r in empty] == [0.0, 0.0, 0.0]


def test_tag_histogram_order_and_top():
    tasks = [
        make_task(id=1, tags=("home", "errand")),
        make_task(id=2, tags=("home",)),
        make_task(id=3, tags=("work", "errand")),
        make_task(id=4, tags=("home",)),
    ]
    pairs = tag_histogram(tasks)
    assert pairs == [("home", 3), ("errand", 2), ("work", 1)]
    assert tag_histogram(tasks, top=1) == [("home", 3)]


def test_render_report_sections():
    tasks = [
        make_task(id=1, title="Buy milk", priority=1, tags=("home",), due=rel(2)),
        make_task(id=2, title="Old chore", priority=2, due=None, status="done"),
    ]
    out = render_report(tasks, TODAY, top_tags=3)
    assert "== summary ==" in out
    assert "== by priority ==" in out
    assert "== top tags (max 3) ==" in out
    assert "total:       2" in out
    assert "done:        1" in out
    assert "home" in out
