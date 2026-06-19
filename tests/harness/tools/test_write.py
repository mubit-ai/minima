from __future__ import annotations

from minima_harness.tools.write import WriteParams, _execute, write_tool


async def test_write_creates_file_and_parents(tmp_path):
    target = tmp_path / "nested" / "dir" / "out.txt"
    res = await _execute("c1", WriteParams(path=str(target), content="hello\nworld\n"), None, None)
    assert target.read_text() == "hello\nworld\n"
    assert "wrote 2 lines" in res.content[0].text


async def test_write_overwrites(tmp_path):
    f = tmp_path / "f.txt"
    f.write_text("old")
    await _execute("c1", WriteParams(path=str(f), content="new"), None, None)
    assert f.read_text() == "new"


def test_write_tool_descriptor():
    assert write_tool().name == "write"
