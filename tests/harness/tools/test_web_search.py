from __future__ import annotations

import httpx
import respx

from minima_harness.tools.web_search import WebSearchParams, _execute, web_search_tool

SEARCH_URL = "https://api.exa.ai/search"


@respx.mock
async def test_formats_numbered_results(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {"title": "First", "url": "https://a.com", "id": "1", "publishedDate": "2024"},
                    {"url": "https://b.com", "id": "2"},
                ]
            },
        )
    )
    res = await _execute("c1", WebSearchParams(query="q"), None, None)
    text = res.content[0].text
    assert "[1] First (2024)" in text
    assert "https://a.com" in text
    assert "[2] (no title)" in text
    assert res.details["count"] == 2


@respx.mock
async def test_no_results(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(return_value=httpx.Response(200, json={"results": []}))
    res = await _execute("c1", WebSearchParams(query="q"), None, None)
    assert "No results" in res.content[0].text
    assert res.details["count"] == 0


@respx.mock
async def test_auth_failure_returns_error_result(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "bad")
    respx.post(SEARCH_URL).mock(return_value=httpx.Response(401))
    res = await _execute("c1", WebSearchParams(query="q"), None, None)
    assert "web_search failed" in res.content[0].text


def test_tool_descriptor():
    tool = web_search_tool()
    assert tool.name == "web_search"
    assert tool.parameters is WebSearchParams
