from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, ToolUpdate, error_result
from minima_harness.ai.types import TextContent


class BashParams(BaseModel):
    command: str
    timeout: int = Field(default=120_000, ge=1)  # milliseconds
    workdir: str | None = None


async def _execute(
    tool_call_id: str,
    params,
    signal,
    on_update: ToolUpdate | None,  # noqa: ANN001
) -> ToolResult:
    assert isinstance(params, BashParams)
    wd = str(Path(params.workdir).expanduser()) if params.workdir else None
    try:
        proc = await asyncio.create_subprocess_shell(
            params.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=wd,
            start_new_session=True,
        )
    except OSError as exc:
        return error_result(f"bash: failed to start: {exc}")

    chunks: list[str] = []
    assert proc.stdout is not None
    try:
        async with asyncio.timeout(params.timeout / 1000.0):
            async for raw in proc.stdout:
                chunk = raw.decode("utf-8", errors="replace")
                chunks.append(chunk)
                if on_update is not None:
                    try:
                        on_update(chunk)
                    except Exception:  # noqa: BLE001 - progress must never break the run
                        pass
            await proc.wait()
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return error_result(f"bash: timed out after {params.timeout} ms")

    output = "".join(chunks)
    code = proc.returncode if proc.returncode is not None else -1
    body = f"{output}\n[exit {code}]" if output else f"[exit {code}]"
    return ToolResult(content=[TextContent(text=body)], details={"exit_code": code})


def bash_tool() -> AgentTool:
    return AgentTool(
        name="bash",
        description=(
            "Run a shell command and return its combined stdout/stderr and exit code. "
            "Output streams live. Runs with the user's full permissions — no confirmation."
        ),
        parameters=BashParams,
        execute=_execute,
    )
