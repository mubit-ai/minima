from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent


class GrepParams(BaseModel):
    pattern: str
    path: str = "."
    include: str | None = None


def _re_walk(root: Path, pattern: str, include: str | None) -> str:
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return f"(invalid regex: {exc})"
    glob_pat = include or "*"
    hits: list[str] = []
    for file in root.rglob(glob_pat):
        if not file.is_file():
            continue
        try:
            text = file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            if regex.search(line):
                hits.append(f"{file}:{i}:{line}")
    return "\n".join(hits) if hits else "(no matches)"


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, GrepParams)
    root = Path(params.path).expanduser()
    if not root.exists():
        return error_result(f"grep: no such path: {root}")

    if shutil.which("rg"):
        cmd = ["rg", "-n", "--color=never"]
        if params.include:
            cmd += ["-g", params.include]
        cmd += ["--", params.pattern, str(root)]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await proc.communicate()
        if proc.returncode not in (0, 1):  # 1 = no matches, 0 = matches
            return error_result(f"grep: {err.decode('utf-8', 'replace').strip()}")
        body = out.decode("utf-8", "replace").strip() or "(no matches)"
    else:
        body = _re_walk(root, params.pattern, params.include)

    return ToolResult(content=[TextContent(text=body)], details={"path": str(root)})


def grep_tool() -> AgentTool:
    return AgentTool(
        name="grep",
        description=(
            "Search file contents for a regex pattern. Uses ripgrep when available, "
            "else a pure-Python recursive walk. Returns file:line:match lines."
        ),
        parameters=GrepParams,
        execute=_execute,
    )
