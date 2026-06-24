from __future__ import annotations

from minima_harness.agent.tools import find_agent_tool
from minima_harness.minima.config import HarnessConfig
from minima_harness.minima.runtime import MinimaAgent
from minima_harness.tools import default_toolset


def test_minima_agent_accepts_default_toolset():
    agent = MinimaAgent(HarnessConfig(allow_offline=True), tools=default_toolset())
    names = {t.name for t in agent.state.tools}
    assert {"read", "write", "edit", "bash", "grep", "find", "ls"} <= names


def test_tool_params_validate():
    tools = default_toolset()
    bash = find_agent_tool(tools, "bash")
    assert bash is not None
    params = bash.parameters.model_validate({"command": "echo hi", "timeout": 1000})
    assert params.command == "echo hi"
    assert params.timeout == 1000
