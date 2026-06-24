from __future__ import annotations

from minima_harness.tools.edit import EditParams, _execute, edit_tool


async def test_edit_replaces_single(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("foo bar baz")
    await _execute("c1", EditParams(path=str(f), old_string="bar", new_string="QUX"), None, None)
    assert f.read_text() == "foo QUX baz"


async def test_edit_replace_all(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("x x x")
    await _execute(
        "c1", EditParams(path=str(f), old_string="x", new_string="y", replace_all=True), None, None
    )
    assert f.read_text() == "y y y"


async def test_edit_no_match_errors(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("hello")
    res = await _execute(
        "c1", EditParams(path=str(f), old_string="zzz", new_string="y"), None, None
    )
    assert "not found" in res.content[0].text.lower()


async def test_edit_ambiguous_without_replace_all_errors(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("dup dup")
    res = await _execute(
        "c1", EditParams(path=str(f), old_string="dup", new_string="y"), None, None
    )
    assert "2 times" in res.content[0].text or "matches" in res.content[0].text.lower()
    assert f.read_text() == "dup dup"  # unchanged


def test_edit_tool_descriptor():
    assert edit_tool().name == "edit"
