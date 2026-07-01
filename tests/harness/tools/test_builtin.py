from __future__ import annotations

from minima_harness.tools import default_toolset


def test_default_toolset_has_named_tools(monkeypatch):
    # The experimental lsp tool is gated by env; assert the stable default set without it.
    monkeypatch.delenv("MINIMA_EXPERIMENTAL_LSP", raising=False)
    tools = default_toolset()
    names = [t.name for t in tools]
    assert names == [
        "read",
        "write",
        "edit",
        "apply_patch",
        "bash",
        "grep",
        "find",
        "ls",
        "web_search",
        "web_fetch",
    ]


def test_lsp_tool_appended_when_experimental_flag_set(monkeypatch):
    monkeypatch.setenv("MINIMA_EXPERIMENTAL_LSP", "1")
    names = [t.name for t in default_toolset()]
    assert names[-1] == "lsp"  # appended last, after the web tools
    assert "lsp" not in names[:-1]


def test_find_agent_tool_locates_by_name():
    from minima_harness.agent.tools import find_agent_tool

    tools = default_toolset()
    assert find_agent_tool(tools, "bash") is not None
    assert find_agent_tool(tools, "nope") is None
