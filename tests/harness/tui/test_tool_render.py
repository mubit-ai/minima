"""IDE-like tool-call rendering (no raw JSON arg dumps)."""

from __future__ import annotations

from minima_harness.tui.app import _format_tool_call


def test_write_shows_path_lines_and_preview():
    out = _format_tool_call("write", {"path": "notes.md", "content": "# Title\n\nbody\nmore"})
    assert "notes.md" in out
    assert "4 lines" in out  # line count, not a raw dump
    assert "+# Title" in out  # + prefixed content preview
    assert "'content'" not in out and "\\n" not in out  # NOT the raw JSON args dump


def test_write_truncates_long_content():
    content = "\n".join(f"line{i}" for i in range(50))
    out = _format_tool_call("write", {"path": "big.txt", "content": content})
    assert "more line" in out  # truncation note
    assert out.count("\n") < 50  # not the whole file


def test_edit_renders_a_diff():
    out = _format_tool_call(
        "edit", {"path": "a.py", "old_string": "x = 1", "new_string": "x = 2"}
    )
    assert "a.py" in out
    assert "-x = 1" in out and "+x = 2" in out  # unified diff lines
    assert "old_string" not in out  # not the raw args


def test_read_shows_path_and_range():
    assert _format_tool_call("read", {"path": "a.py"}) == "a.py"
    assert "from line 40" in _format_tool_call("read", {"path": "a.py", "offset": 40})


def test_bash_shows_command():
    assert _format_tool_call("bash", {"command": "ls -la"}) == "$ ls -la"


def test_unknown_tool_is_compact_kv_not_json():
    out = _format_tool_call("mystery", {"foo": "bar", "n": 3})
    assert "foo=bar" in out and "n=3" in out
    assert "{" not in out  # not a JSON/dict dump


def test_handles_pydantic_like_args():
    from types import SimpleNamespace

    out = _format_tool_call("bash", SimpleNamespace(command="echo hi"))
    assert out == "$ echo hi"
