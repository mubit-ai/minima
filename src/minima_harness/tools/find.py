from __future__ import annotations

import glob
from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult
from minima_harness.ai.types import TextContent


class FindParams(BaseModel):
    pattern: str
    path: str = "."


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, FindParams)
    root = Path(params.path).expanduser()
    pat = str(root / params.pattern)
    matches = sorted(glob.glob(pat, recursive=True))
    body = "\n".join(matches) if matches else "(no matches)"
    return ToolResult(
        content=[TextContent(text=body)],
        details={"count": len(matches)},
    )


def find_tool() -> AgentTool:
    return AgentTool(
        name="find",
        description=(
            "Find files matching a glob pattern (supports ** for recursive search). "
            "Returns file paths only."
        ),
        parameters=FindParams,
        execute=_execute,
    )
