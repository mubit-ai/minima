"""Hand-verification that EVERY catalog provider is wired correctly.

A live call needs each provider's real API key, but the *integration logic* — which base_url
to hit, which key env var to read, what payload to send, how to parse the reply — is fully
checkable offline. For each OpenAI-compatible provider in the catalog we drive the real
``OpenAICompatProvider`` against an ``httpx.MockTransport`` that captures the outgoing request
and returns a canned chat-completions SSE stream, then assert:

  - the request goes to ``{provider.base_url}/chat/completions`` (catalog base_url is correct),
  - the Authorization header carries *this* provider's key (key-env resolution is correct),
  - the payload model id matches, and the SSE reply parses to text + usage.

The two native providers (anthropic, google) use their SDKs and are round-trip-tested with
fake clients in test_minima_e2e / test_app_pilot / test_google_mapping. Together these cover
all 21 providers' wiring. A genuinely *live* smoke test lives in test_live.py (needs keys).
"""

from __future__ import annotations

import json

import httpx
import pytest

from minima_harness.ai.provider_catalog import CATALOG_MODELS, PROVIDERS, _to_model
from minima_harness.ai.stream import stream as ai_stream
from minima_harness.ai.types import Context, Message, Modality, Model, ModelCost

_OPENAI_COMPAT = [p for p in PROVIDERS if p.api == "openai-completions"]
_DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"


def _canned_sse() -> str:
    """A minimal but valid chat-completions SSE stream: one text delta + usage + DONE."""
    return (
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n'
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n'
        "data: [DONE]\n\n"
    )


def _model_for(spec) -> Model:  # noqa: ANN001
    """A representative model for the provider (its first catalog model, else a synthetic one)."""
    catalog = CATALOG_MODELS.get(spec.name)
    if catalog:
        return _to_model(spec.name, spec, catalog[0])
    # Local runtimes carry no curated catalog (you run whatever you loaded) — synthesize one.
    return Model(
        id="local-test-model",
        provider=spec.name,
        api=spec.api,
        name="local",
        cost=ModelCost(input=0.0, output=0.0),
        context_window=8192,
        max_tokens=128,
        input=(Modality.text,),
        base_url=spec.base_url,
    )


@pytest.mark.parametrize("spec", _OPENAI_COMPAT, ids=[p.name for p in _OPENAI_COMPAT])
@pytest.mark.asyncio
async def test_openai_compat_provider_wiring(spec, monkeypatch):
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, text=_canned_sse(), headers={"content-type": "text/event-stream"}
        )

    # Only THIS provider's key is set, to a sentinel — proves the provider reads its own env var
    # (not some other provider's key) and never sends a real secret.
    for other in PROVIDERS:
        for var in other.env_vars:
            monkeypatch.delenv(var, raising=False)
    keyvar = spec.env_vars[0]
    monkeypatch.setenv(keyvar, "sk-wiring-sentinel")

    model = _model_for(spec)
    ctx = Context(system_prompt="be brief", messages=[Message(role="user", content="ping")])
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    stream = ai_stream(model, ctx, options={"httpx_client": client})
    async for _ in stream:
        pass
    final = await stream.result()
    await client.aclose()

    expected_base = (spec.base_url or _DEFAULT_OPENAI_BASE).rstrip("/")
    assert captured["url"] == f"{expected_base}/chat/completions", spec.name
    assert captured["auth"] == "Bearer sk-wiring-sentinel", f"{spec.name} key-env resolution"
    assert captured["body"]["model"] == model.id, spec.name
    assert captured["body"]["stream"] is True
    # Reply parsed correctly.
    assert final.stop_reason == "stop", spec.name
    assert final.text == "pong", spec.name
    assert final.usage.output == 1, spec.name


@pytest.mark.asyncio
async def test_key_isolation_no_cross_provider_leak(monkeypatch):
    """A Groq model must NEVER borrow another provider's key — only GROQ_API_KEY."""
    for other in PROVIDERS:
        for var in other.env_vars:
            monkeypatch.delenv(var, raising=False)
    # Set a DIFFERENT provider's key; the groq call must NOT pick it up.
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-openrouter-should-not-be-used")

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("Authorization")
        return httpx.Response(
            200, text=_canned_sse(), headers={"content-type": "text/event-stream"}
        )

    groq = next(p for p in PROVIDERS if p.name == "groq")
    model = _model_for(groq)
    ctx = Context(system_prompt="", messages=[Message(role="user", content="ping")])
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    stream = ai_stream(model, ctx, options={"httpx_client": client})
    async for _ in stream:
        pass
    await stream.result()
    await client.aclose()

    # No GROQ_API_KEY set -> no auth header at all (rather than borrowing OpenRouter's key).
    assert captured["auth"] is None


@pytest.mark.parametrize(
    "provider_name,expected_key,forbidden_key",
    [
        ("openai", "max_completion_tokens", "max_tokens"),  # GPT-5/o-series reject max_tokens
        ("groq", "max_tokens", "max_completion_tokens"),  # other OpenAI-compat hosts use classic
    ],
)
@pytest.mark.asyncio
async def test_max_output_token_param_per_provider(
    provider_name, expected_key, forbidden_key, monkeypatch
):
    spec = next(p for p in PROVIDERS if p.name == provider_name)
    monkeypatch.setenv(spec.env_vars[0], "sk-sentinel")
    body: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body.update(json.loads(request.content))
        return httpx.Response(
            200, text=_canned_sse(), headers={"content-type": "text/event-stream"}
        )

    model = _model_for(spec)
    ctx = Context(system_prompt="", messages=[Message(role="user", content="ping")])
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    stream = ai_stream(model, ctx, options={"httpx_client": client})
    async for _ in stream:
        pass
    await stream.result()
    await client.aclose()

    assert expected_key in body
    assert forbidden_key not in body
