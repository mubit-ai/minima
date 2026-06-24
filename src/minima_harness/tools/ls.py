from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent


class LsParams(BaseModel):
    path: str = "."


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, LsParams)
    root = Path(params.path).expanduser()
    if not root.exists():
        return error_result(f"ls: no such path: {root}")
    entries = sorted(root.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    if not entries:
        return ToolResult(content=[TextContent(text="(empty)")])
    lines = [(f"{e.name}/" if e.is_dir() else e.name) for e in entries]
    return ToolResult(content=[TextContent(text="\n".join(lines))], details={"count": len(lines)})


def ls_tool() -> AgentTool:
    return AgentTool(
        name="ls",
        description=(
            "List entries in a directory. Directories are suffixed with / and sorted first."
        ),
        parameters=LsParams,
        execute=_execute,
    )
