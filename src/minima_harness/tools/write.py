from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult
from minima_harness.ai.types import TextContent
from minima_harness.tools._io import write_text


class WriteParams(BaseModel):
    path: str
    content: str


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, WriteParams)
    p = Path(params.path).expanduser()
    n = write_text(p, params.content)
    return ToolResult(
        content=[TextContent(text=f"wrote {n} lines to {p}")],
        details={"bytes": len(params.content)},
    )


def write_tool() -> AgentTool:
    return AgentTool(
        name="write",
        description=(
            "Create or overwrite a file on the local filesystem. Parent directories "
            "are created automatically. Pass the full intended file contents."
        ),
        parameters=WriteParams,
        execute=_execute,
    )
