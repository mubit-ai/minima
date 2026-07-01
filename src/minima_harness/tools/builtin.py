from __future__ import annotations

from minima_harness.agent.tools import AgentTool
from minima_harness.tools.apply_patch import apply_patch_tool
from minima_harness.tools.bash import bash_tool
from minima_harness.tools.edit import edit_tool
from minima_harness.tools.find import find_tool
from minima_harness.tools.grep import grep_tool
from minima_harness.tools.ls import ls_tool
from minima_harness.tools.read import read_tool
from minima_harness.tools.web_fetch import web_fetch_tool
from minima_harness.tools.web_search import web_search_tool
from minima_harness.tools.write import write_tool


def default_toolset() -> list[AgentTool]:
    """The default tools, in a stable order: PI's coding tools (read/write/edit/
    apply_patch/bash/grep/find/ls) plus the Exa-backed web tools. apply_patch is
    the multi-file/atomic counterpart to the single-shot edit. The web tools need
    ``EXA_API_KEY`` set to run, but
    constructing them (and the toolset) never touches the network or the key.

    The experimental ``lsp`` code-intelligence tool is appended only when
    ``MINIMA_EXPERIMENTAL_LSP`` is set, so it stays out of the schema by default."""
    tools = [
        read_tool(),
        write_tool(),
        edit_tool(),
        apply_patch_tool(),
        bash_tool(),
        grep_tool(),
        find_tool(),
        ls_tool(),
        web_search_tool(),
        web_fetch_tool(),
    ]
    from minima_harness.lsp import lsp_enabled

    if lsp_enabled():
        from minima_harness.tools.lsp import lsp_tool

        tools.append(lsp_tool())
    return tools


def web_toolset() -> list[AgentTool]:
    """Just the Exa-backed web research tools (search + fetch)."""
    return [web_search_tool(), web_fetch_tool()]
