from __future__ import annotations

from minima_harness.agent.tools import AgentTool
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
    """The default tools, in a stable order: PI's seven coding tools plus the
    Exa-backed web tools. The web tools need ``EXA_API_KEY`` set to run, but
    constructing them (and the toolset) never touches the network or the key."""
    return [
        read_tool(),
        write_tool(),
        edit_tool(),
        bash_tool(),
        grep_tool(),
        find_tool(),
        ls_tool(),
        web_search_tool(),
        web_fetch_tool(),
    ]


def web_toolset() -> list[AgentTool]:
    """Just the Exa-backed web research tools (search + fetch)."""
    return [web_search_tool(), web_fetch_tool()]
