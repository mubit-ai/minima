from __future__ import annotations

import httpx
import respx

from minima_harness.tools.web_fetch import WebFetchParams, _execute, web_fetch_tool

CONTENTS_URL = "https://api.exa.ai/contents"


@respx.mock
async def test_returns_text_with_title(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(CONTENTS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {"url": "https://a.com", "id": "1", "title": "Doc", "text": "hello body"}
                ]
            },
        )
    )
    res = await _execute("c1", WebFetchParams(url="https://a.com"), None, None)
    text = res.content[0].text
    assert text.startswith("# Doc")
    assert "hello body" in text
    assert res.details["truncated"] is False


@respx.mock
async def test_truncates_long_text(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    long_text = "x" * 600
    respx.post(CONTENTS_URL).mock(
        return_value=httpx.Response(
            200, json={"results": [{"url": "https://a.com", "id": "1", "text": long_text}]}
        )
    )
    res = await _execute("c1", WebFetchParams(url="https://a.com", max_chars=500), None, None)
    text = res.content[0].text
    assert "[truncated — 100 more chars]" in text
    assert res.details["truncated"] is True
    assert res.details["chars"] == 500


@respx.mock
async def test_empty_text_is_error(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(CONTENTS_URL).mock(
        return_value=httpx.Response(
            200, json={"results": [{"url": "https://a.com", "id": "1", "text": "   "}]}
        )
    )
    res = await _execute("c1", WebFetchParams(url="https://a.com"), None, None)
    assert "no extractable text" in res.content[0].text


@respx.mock
async def test_no_results_is_error(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(CONTENTS_URL).mock(return_value=httpx.Response(200, json={"results": []}))
    res = await _execute("c1", WebFetchParams(url="https://a.com"), None, None)
    assert "no content returned" in res.content[0].text


@respx.mock
async def test_fetch_failure_returns_error_result(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "bad")
    respx.post(CONTENTS_URL).mock(return_value=httpx.Response(401))
    res = await _execute("c1", WebFetchParams(url="https://a.com"), None, None)
    assert "web_fetch failed" in res.content[0].text


def test_tool_descriptor():
    tool = web_fetch_tool()
    assert tool.name == "web_fetch"
    assert tool.parameters is WebFetchParams
