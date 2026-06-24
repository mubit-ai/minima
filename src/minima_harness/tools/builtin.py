from __future__ import annotations

from minima_harness.agent.tools import AgentTool
from minima_harness.tools.bash import bash_tool
from minima_harness.tools.edit import edit_tool
from minima_harness.tools.find import find_tool
from minima_harness.tools.grep import grep_tool
from minima_harness.tools.ls import ls_tool
from minima_harness.tools.read import read_tool
from minima_harness.tools.write import write_tool


def default_toolset() -> list[AgentTool]:
    """PI's seven default coding tools, in a stable order."""
    return [
        read_tool(),
        write_tool(),
        edit_tool(),
        bash_tool(),
        grep_tool(),
        find_tool(),
        ls_tool(),
    ]
