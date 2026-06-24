from __future__ import annotations

from minima_harness.tools.bash import BashParams, _execute, bash_tool


async def test_bash_captures_stdout():
    cmd = "echo hello"
    res = await _execute("c1", BashParams(command=cmd), None, None)
    assert "hello" in res.content[0].text
    assert "[exit 0]" in res.content[0].text


async def test_bash_streams_via_on_update():
    seen: list[str] = []
    await _execute(
        "c1", BashParams(command="echo streamed"), None, lambda chunk: seen.append(chunk)
    )
    assert any("streamed" in c for c in seen)


async def test_bash_nonzero_exit():
    cmd = "exit 7"
    res = await _execute("c1", BashParams(command=cmd), None, None)
    assert "[exit 7]" in res.content[0].text


async def test_bash_timeout_kills():
    # sleep far longer than the timeout (200 ms)
    cmd = "sleep 5"
    res = await _execute("c1", BashParams(command=cmd, timeout=200), None, None)
    assert "timed out" in res.content[0].text.lower()


async def test_bash_workdir(tmp_path):
    cmd = "pwd"
    res = await _execute("c1", BashParams(command=cmd, workdir=str(tmp_path)), None, None)
    assert str(tmp_path) in res.content[0].text


def test_bash_tool_descriptor():
    assert bash_tool().name == "bash"
