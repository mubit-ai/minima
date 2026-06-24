from __future__ import annotations

from minima_harness.tools.ls import LsParams, _execute, ls_tool


async def test_ls_lists_dirs_first(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    (tmp_path / "subdir").mkdir()
    res = await _execute("c1", LsParams(path=str(tmp_path)), None, None)
    text = res.content[0].text
    assert "subdir/" in text and "file.txt" in text
    assert text.index("subdir/") < text.index("file.txt")  # dirs first


async def test_ls_missing_path_errors(tmp_path):
    res = await _execute("c1", LsParams(path=str(tmp_path / "nope")), None, None)
    assert "no such path" in res.content[0].text.lower()


async def test_ls_empty_dir(tmp_path):
    res = await _execute("c1", LsParams(path=str(tmp_path)), None, None)
    assert "empty" in res.content[0].text.lower()


def test_ls_tool_descriptor():
    assert ls_tool().name == "ls"
