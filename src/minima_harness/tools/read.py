from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent
from minima_harness.tools._io import read_lines


class ReadParams(BaseModel):
    path: str
    offset: int = Field(default=1, ge=1)
    limit: int = Field(default=2000, ge=1)


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, ReadParams)
    p = Path(params.path).expanduser()
    if not p.exists():
        return error_result(f"read: no such file: {p}")
    if p.is_dir():
        return error_result(f"read: is a directory: {p}")
    body, n = read_lines(p, offset=params.offset, limit=params.limit)
    return ToolResult(content=[TextContent(text=body or "(empty)")], details={"lines_read": n})


def read_tool() -> AgentTool:
    return AgentTool(
        name="read",
        description=(
            "Read a text file from the local filesystem. Returns lines with 1-based "
            "line numbers. Use `offset` and `limit` to page through large files."
        ),
        parameters=ReadParams,
        execute=_execute,
    )
