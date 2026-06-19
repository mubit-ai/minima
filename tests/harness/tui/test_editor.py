from __future__ import annotations

from minima_harness.tui.editor import expand_at_files, parse_submission, run_bash


def test_parse_command():
    assert parse_submission("/model sonnet") == {
        "kind": "command",
        "name": "model",
        "args": "sonnet",
    }


def test_parse_bash_feed():
    assert parse_submission("!ls -l") == {"kind": "bash", "command": "ls -l", "feed": True}


def test_parse_bash_nofeed():
    assert parse_submission("!!make test") == {
        "kind": "bash",
        "command": "make test",
        "feed": False,
    }


def test_parse_message():
    assert parse_submission("hello world") == {"kind": "message", "text": "hello world"}


def test_expand_at_files(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("CONTENT")
    out = expand_at_files(f"see @{f}")
    assert "CONTENT" in out and '<file path="' in out


async def test_run_bash():
    out = await run_bash("echo hi")
    assert "hi" in out
