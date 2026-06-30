from __future__ import annotations

from pydantic import BaseModel, Field

from minima_harness.agent.tools import AgentTool, ToolResult, ToolUpdate, error_result
from minima_harness.ai.types import TextContent
from minima_harness.tools._exa import ExaError, exa_search


class WebSearchParams(BaseModel):
    query: str = Field(description="The search query.")
    num_results: int = Field(default=5, ge=1, le=10, description="How many results to return.")


async def _execute(
    tool_call_id: str,
    params,  # noqa: ANN001
    signal,  # noqa: ANN001
    on_update: ToolUpdate | None,
) -> ToolResult:
    assert isinstance(params, WebSearchParams)
    try:
        data = await exa_search(params.query, params.num_results)
    except ExaError as exc:  # auth / transient / bad-response all surface here
        return error_result(f"web_search failed: {exc}")

    if not data.results:
        return ToolResult(content=[TextContent(text="No results found.")], details={"count": 0})

    lines: list[str] = []
    for i, r in enumerate(data.results, 1):
        title = r.title or "(no title)"
        date = f" ({r.published_date})" if r.published_date else ""
        lines.append(f"[{i}] {title}{date}\n    {r.url}")
    body = "\n".join(lines)
    return ToolResult(content=[TextContent(text=body)], details={"count": len(data.results)})


def web_search_tool() -> AgentTool:
    return AgentTool(
        name="web_search",
        description=(
            "Search the web for current information. Returns a numbered list of "
            "results with titles and URLs. Use this when you need facts you don't "
            "know or that may have changed. To read a result, pass its URL to web_fetch."
        ),
        parameters=WebSearchParams,
        execute=_execute,
    )
