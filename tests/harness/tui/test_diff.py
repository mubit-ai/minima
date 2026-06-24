"""Tests for the diff preview used by the edit/write approval modal."""

from __future__ import annotations

from pydantic import BaseModel

from minima_harness.tui.diff import render_tool_diff


class _Edit(BaseModel):
    path: str
    old_string: str
    new_string: str
    replace_all: bool = False


class _Write(BaseModel):
    path: str
    content: str


def test_edit_diff_shows_added_and_removed_lines():
    d = render_tool_diff("edit", _Edit(path="foo.py", old_string="a = 1", new_string="a = 2"))
    assert "-a = 1" in d
    assert "+a = 2" in d
    assert "foo.py" in d


def test_write_diff_new_file():
    d = render_tool_diff("write", _Write(path="/nope/does-not-exist.txt", content="hello\nworld"))
    assert "new file" in d
    assert "+hello" in d
    assert "+world" in d


def test_write_diff_against_existing_file(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("line1\nline2\n", encoding="utf-8")
    d = render_tool_diff("write", _Write(path=str(f), content="line1\nCHANGED\n"))
    assert "-line2" in d
    assert "+CHANGED" in d


def test_unknown_tool_falls_back():
    assert "bash" in render_tool_diff("bash", _Write(path="p", content="c"))
