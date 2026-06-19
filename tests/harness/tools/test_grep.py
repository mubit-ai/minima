from __future__ import annotations

from minima_harness.tools.grep import GrepParams, _execute, grep_tool


async def test_grep_pure_re_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)  # force the re fallback
    (tmp_path / "a.py").write_text("def hello():\n    pass\n")
    (tmp_path / "b.py").write_text("nope\n")
    res = await _execute("c1", GrepParams(pattern="hello", path=str(tmp_path)), None, None)
    assert "a.py" in res.content[0].text
    assert "hello" in res.content[0].text
    assert "b.py" not in res.content[0].text


async def test_grep_no_matches(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    (tmp_path / "a.py").write_text("x\n")
    res = await _execute("c1", GrepParams(pattern="zzz", path=str(tmp_path)), None, None)
    assert "no matches" in res.content[0].text.lower()


async def test_grep_missing_path_errors(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    res = await _execute("c1", GrepParams(pattern="x", path=str(tmp_path / "nope")), None, None)
    assert "no such path" in res.content[0].text.lower()


def test_grep_tool_descriptor():
    assert grep_tool().name == "grep"
