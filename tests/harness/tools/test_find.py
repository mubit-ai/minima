from __future__ import annotations

from minima_harness.tools.find import FindParams, _execute, find_tool


async def test_find_matches_glob(tmp_path):
    (tmp_path / "a.py").write_text("x")
    (tmp_path / "b.txt").write_text("x")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "c.py").write_text("x")
    res = await _execute("c1", FindParams(pattern="**/*.py", path=str(tmp_path)), None, None)
    text = res.content[0].text
    assert "a.py" in text and "c.py" in text and "b.txt" not in text


async def test_find_no_matches(tmp_path):
    res = await _execute("c1", FindParams(pattern="*.zzz", path=str(tmp_path)), None, None)
    assert "no matches" in res.content[0].text.lower()


def test_find_tool_descriptor():
    assert find_tool().name == "find"
