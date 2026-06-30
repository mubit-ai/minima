from __future__ import annotations

from minima_harness.tools import default_toolset


def test_default_toolset_has_named_tools():
    tools = default_toolset()
    names = [t.name for t in tools]
    assert names == [
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        "web_search",
        "web_fetch",
    ]


def test_find_agent_tool_locates_by_name():
    from minima_harness.agent.tools import find_agent_tool

    tools = default_toolset()
    assert find_agent_tool(tools, "bash") is not None
    assert find_agent_tool(tools, "nope") is None
