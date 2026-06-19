from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from minima_harness.agent.tools import AgentTool, ToolResult, error_result
from minima_harness.ai.types import TextContent


class EditParams(BaseModel):
    path: str
    old_string: str
    new_string: str
    replace_all: bool = False


async def _execute(tool_call_id: str, params, signal, on_update) -> ToolResult:  # noqa: ANN001
    assert isinstance(params, EditParams)
    p = Path(params.path).expanduser()
    if not p.exists():
        return error_result(f"edit: no such file: {p}")
    text = p.read_text(encoding="utf-8")
    count = text.count(params.old_string)
    if count == 0:
        return error_result(f"edit: old_string not found in {p}")
    if count > 1 and not params.replace_all:
        return error_result(
            f"edit: old_string matches {count} times in {p}; "
            "add more surrounding context or set replace_all=True"
        )
    new = text.replace(params.old_string, params.new_string)
    p.write_text(new, encoding="utf-8")
    replaced = count if params.replace_all else 1
    return ToolResult(
        content=[TextContent(text=f"edited {p}: {replaced} replacement(s)")],
        details={"replacements": replaced},
    )


def edit_tool() -> AgentTool:
    return AgentTool(
        name="edit",
        description=(
            "Replace an exact string in a file. Errors if old_string is absent or "
            "(without replace_all) appears more than once — add context to disambiguate."
        ),
        parameters=EditParams,
        execute=_execute,
    )
