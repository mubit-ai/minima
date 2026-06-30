from __future__ import annotations

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, ToolUpdate, error_result
from minima_harness.ai.types import TextContent
from minima_harness.tools._exa import ExaError, exa_contents


class WebFetchParams(BaseModel):
    url: str = Field(description="The URL to fetch and read.")
    max_chars: int = Field(
        default=8000,
        ge=500,
        le=50_000,
        description="Maximum characters of page text to return (output is truncated past this).",
    )


async def _execute(
    tool_call_id: str,
    params,  # noqa: ANN001
    signal,  # noqa: ANN001
    on_update: ToolUpdate | None,
) -> ToolResult:
    assert isinstance(params, WebFetchParams)
    try:
        data = await exa_contents([params.url], max_chars=params.max_chars)
    except ExaError as exc:
        return error_result(f"web_fetch failed: {exc}")

    if not data.results:
        return error_result(f"web_fetch: no content returned for {params.url}")

    r = data.results[0]
    text = (r.text or "").strip()
    if not text:
        return error_result(f"web_fetch: page had no extractable text ({params.url})")

    suffix = ""
    if len(text) > params.max_chars:
        extra = len(text) - params.max_chars
        text = text[: params.max_chars]
        suffix = f"\n\n[truncated — {extra} more chars]"

    header = f"# {r.title}\n{params.url}\n\n" if r.title else f"{params.url}\n\n"
    body = header + text + suffix
    return ToolResult(
        content=[TextContent(text=body)],
        details={"url": params.url, "chars": len(text), "truncated": bool(suffix)},
    )


def web_fetch_tool() -> AgentTool:
    return AgentTool(
        name="web_fetch",
        description=(
            "Fetch a single URL and return its main readable text (not raw HTML). "
            "Use after web_search to read a result, or on any URL you already have. "
            "Long pages are truncated; raise max_chars if you need more."
        ),
        parameters=WebFetchParams,
        execute=_execute,
    )
