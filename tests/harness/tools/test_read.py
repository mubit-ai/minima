from __future__ import annotations

from minima_harness.tools.read import ReadParams, _execute, read_tool


async def test_read_returns_numbered_content(tmp_path):
    f = tmp_path / "f.py"
    f.write_text("alpha\nbeta\n")
    res = await _execute("c1", ReadParams(path=str(f)), None, None)
    assert res.content[0].text.startswith("1: alpha")
    assert "2: beta" in res.content[0].text


async def test_read_offset_and_limit(tmp_path):
    f = tmp_path / "f.py"
    f.write_text("x\ny\nz\n")
    res = await _execute("c1", ReadParams(path=str(f), offset=2, limit=1), None, None)
    assert "y" in res.content[0].text and "x" not in res.content[0].text


async def test_read_missing_file_errors(tmp_path):
    res = await _execute("c1", ReadParams(path=str(tmp_path / "nope")), None, None)
    assert "no such file" in res.content[0].text.lower()


async def test_read_directory_errors(tmp_path):
    res = await _execute("c1", ReadParams(path=str(tmp_path)), None, None)
    assert "directory" in res.content[0].text.lower()


def test_read_tool_descriptor():
    t = read_tool()
    assert t.name == "read"
    assert t.parameters is ReadParams
