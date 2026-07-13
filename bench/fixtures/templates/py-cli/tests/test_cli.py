"""End-to-end CLI tests driving taskman.cli.main with a temp file."""

import json

from taskman.cli import ENV_FILE, main

TODAY_FLAG = ["--today", "2026-03-15"]


def run(store_path, *argv):
    """Invoke the CLI against ``store_path`` with a pinned today."""
    return main(["--file", str(store_path), *TODAY_FLAG, *argv])


def test_add_and_list_roundtrip(store_path, capsys):
    rc = run(
        store_path,
        "add",
        "Buy milk",
        "--priority",
        "high",
        "--tags",
        "home,errand",
        "--due",
        "2026-03-18",
    )
    assert rc == 0
    assert "added #1: Buy milk [high]" in capsys.readouterr().out
    rc = run(store_path, "list")
    assert rc == 0
    out = capsys.readouterr().out
    assert "Buy milk" in out
    assert "home,errand" in out
    assert "2026-03-18" in out


def test_add_edge_cases(store_path, capsys):
    rc = run(store_path, "add", "Water plants")
    assert rc == 0
    assert "added #1: Water plants" in capsys.readouterr().out
    rc = run(store_path, "add", "Bad date", "--due", "someday")
    assert rc == 1
    assert "error:" in capsys.readouterr().err


def test_list_default_hides_done(store_path, capsys):
    run(store_path, "add", "Keep me", "-p", "2")
    run(store_path, "add", "Finish me", "-p", "2")
    run(store_path, "done", "2")
    capsys.readouterr()
    run(store_path, "list")
    out = capsys.readouterr().out
    assert "Keep me" in out
    assert "Finish me" not in out
    run(store_path, "list", "--status", "done")
    out = capsys.readouterr().out
    assert "Finish me" in out and "Keep me" not in out
    run(store_path, "list", "--status", "all")
    out = capsys.readouterr().out
    assert "Finish me" in out and "Keep me" in out


def test_list_tag_and_search_filters(store_path, capsys):
    run(store_path, "add", "Mow lawn", "-p", "2", "--tags", "garden")
    run(store_path, "add", "Send invoice", "-p", "1", "--tags", "work")
    capsys.readouterr()
    run(store_path, "list", "--tag", "garden")
    out = capsys.readouterr().out
    assert "Mow lawn" in out
    assert "Send invoice" not in out
    run(store_path, "list", "--search", "invoice")
    out = capsys.readouterr().out
    assert "Send invoice" in out
    assert "Mow lawn" not in out


def test_list_overdue_flag(store_path, capsys):
    run(store_path, "add", "Late one", "-p", "2", "--due", "2026-03-10")
    run(store_path, "add", "Future one", "-p", "2", "--due", "2026-03-25")
    capsys.readouterr()
    run(store_path, "list", "--overdue")
    out = capsys.readouterr().out
    assert "Late one" in out
    assert "Future one" not in out


def test_list_due_within(store_path, capsys):
    run(store_path, "add", "Soon", "-p", "2", "--due", "2026-03-17")
    run(store_path, "add", "Far", "-p", "2", "--due", "2026-04-14")
    capsys.readouterr()
    run(store_path, "list", "--due-within", "7")
    out = capsys.readouterr().out
    assert "Soon" in out
    assert "Far" not in out


def test_list_priority_range(store_path, capsys):
    run(store_path, "add", "Urgent thing", "-p", "high")
    run(store_path, "add", "Someday thing", "-p", "low")
    capsys.readouterr()
    run(store_path, "list", "--priority-max", "medium")
    out = capsys.readouterr().out
    assert "Urgent thing" in out
    assert "Someday thing" not in out


def test_list_sort_by_due(store_path, capsys):
    run(store_path, "add", "Second", "-p", "2", "--due", "2026-03-20")
    run(store_path, "add", "First", "-p", "2", "--due", "2026-03-16")
    run(store_path, "add", "Undated", "-p", "2")
    capsys.readouterr()
    run(store_path, "list", "--sort", "due")
    out = capsys.readouterr().out
    assert out.index("First") < out.index("Second") < out.index("Undated")


def test_agenda_command(store_path, capsys):
    run(store_path, "add", "Late one", "-p", "2", "--due", "2026-03-12")
    run(store_path, "add", "Near one", "-p", "2", "--due", "2026-03-18")
    run(store_path, "add", "Whenever", "-p", "3")
    capsys.readouterr()
    rc = run(store_path, "agenda")
    assert rc == 0
    out = capsys.readouterr().out
    assert "OVERDUE:" in out and "UPCOMING:" in out and "UNSCHEDULED:" in out
    assert out.index("Late one") < out.index("Near one") < out.index("Whenever")


def test_done_and_rm(store_path, capsys):
    run(store_path, "add", "Disposable", "-p", "3")
    rc = run(store_path, "done", "1")
    assert rc == 0
    assert "done #1" in capsys.readouterr().out
    rc = run(store_path, "rm", "1")
    assert rc == 0
    assert "removed #1" in capsys.readouterr().out
    rc = run(store_path, "rm", "1")
    assert rc == 1
    assert "no task with id 1" in capsys.readouterr().err


def test_report_sections_and_counts(store_path, capsys):
    run(store_path, "add", "Alpha", "-p", "high", "--tags", "work", "--due", "2026-03-20")
    run(store_path, "add", "Beta", "-p", "low", "--tags", "work,home")
    run(store_path, "done", "2")
    capsys.readouterr()
    rc = run(store_path, "report", "--top", "2")
    assert rc == 0
    out = capsys.readouterr().out
    assert "== summary ==" in out
    assert "total:       2" in out
    assert "open:        1" in out
    assert "done:        1" in out
    assert "== by priority ==" in out
    assert "work" in out


def test_env_configuration(store_path, monkeypatch, capsys):
    # Storage file via TASKMAN_FILE, "today" via TASKMAN_TODAY.
    monkeypatch.setenv(ENV_FILE, str(store_path))
    monkeypatch.setenv("TASKMAN_TODAY", "2026-03-15")
    rc = main(["add", "Late one", "-p", "2", "--due", "2026-03-10"])
    assert rc == 0
    doc = json.loads(store_path.read_text(encoding="utf-8"))
    assert doc["tasks"][0]["title"] == "Late one"
    capsys.readouterr()
    rc = main(["list", "--overdue"])
    assert rc == 0
    assert "Late one" in capsys.readouterr().out
