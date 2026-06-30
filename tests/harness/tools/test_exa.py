from __future__ import annotations

import httpx
import pytest
import respx

from minima_harness.tools._exa import (
    ExaAuthError,
    ExaError,
    ExaTransientError,
    exa_contents,
    exa_search,
)

SEARCH_URL = "https://api.exa.ai/search"
CONTENTS_URL = "https://api.exa.ai/contents"


@respx.mock
async def test_search_parses_results(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "T1",
                        "url": "https://a.com",
                        "id": "1",
                        "publishedDate": "2024-01-01",
                    },
                    {"url": "https://b.com", "id": "2"},
                ]
            },
        )
    )
    res = await exa_search("hello", 2)
    assert [r.url for r in res.results] == ["https://a.com", "https://b.com"]
    assert res.results[0].published_date == "2024-01-01"  # publishedDate alias
    assert res.results[1].title is None


@respx.mock
async def test_contents_parses_text(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(CONTENTS_URL).mock(
        return_value=httpx.Response(
            200, json={"results": [{"url": "https://a.com", "id": "1", "text": "body"}]}
        )
    )
    res = await exa_contents(["https://a.com"])
    assert res.results[0].text == "body"


async def test_missing_key_raises(monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    with pytest.raises(ExaError, match="EXA_API_KEY is not set"):
        await exa_search("x")


@respx.mock
async def test_auth_error_not_retried(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "bad")
    route = respx.post(SEARCH_URL).mock(return_value=httpx.Response(401))
    with pytest.raises(ExaAuthError):
        await exa_search("x")
    assert route.call_count == 1  # 401 is terminal — no retry


@respx.mock
async def test_bad_request_raises_plain_error(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(return_value=httpx.Response(400, text="bad query"))
    with pytest.raises(ExaError) as ei:
        await exa_search("x")
    assert not isinstance(ei.value, (ExaAuthError, ExaTransientError))


@respx.mock
async def test_transient_then_success_retries(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    route = respx.post(SEARCH_URL).mock(
        side_effect=[
            httpx.Response(429),
            httpx.Response(200, json={"results": [{"url": "https://a.com", "id": "1"}]}),
        ]
    )
    res = await exa_search("x")
    assert res.results[0].url == "https://a.com"
    assert route.call_count == 2  # retried once after the 429


@respx.mock
async def test_network_error_is_transient(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(ExaTransientError):
        await exa_search("x")


@respx.mock
async def test_malformed_json_raises(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "k")
    respx.post(SEARCH_URL).mock(return_value=httpx.Response(200, text="not json"))
    with pytest.raises(ExaError, match="invalid JSON"):
        await exa_search("x")
