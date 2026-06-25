"""Live-OpenRouter-catalog: parsing, modality filtering, caching, and offline fallback."""

from __future__ import annotations

import json

import pytest

from minima_harness.ai import openrouter_catalog as orc

_PAYLOAD = {
    "data": [
        {
            "id": "vendor/chat-model",
            "name": "Vendor Chat",
            "context_length": 200000,
            "pricing": {"prompt": "0.0000005", "completion": "0.0000015"},  # $0.5 / $1.5 per 1M
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
            "top_provider": {"max_completion_tokens": 16384},
            "supported_parameters": ["tools", "reasoning"],
        },
        {
            "id": "vendor/embedding-model",  # output is not text -> must be skipped
            "name": "Vendor Embeddings",
            "pricing": {"prompt": "0.0000001", "completion": "0"},
            "architecture": {"input_modalities": ["text"], "output_modalities": ["embedding"]},
        },
        {
            "id": "vendor/free-model:free",
            "name": "Free Model",
            "context_length": 65536,
            "pricing": {"prompt": "0", "completion": "0"},
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        },
    ]
}


@pytest.fixture(autouse=True)
def _restore_registry():
    # register_openrouter_models() mutates the process-global model registry; snapshot and
    # restore it so a test that registers fixture models can't leak into other suites.
    from minima_harness.ai import registry

    snapshot = dict(registry._MODELS)
    yield
    registry._MODELS.clear()
    registry._MODELS.update(snapshot)


@pytest.fixture
def cache_in_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(orc, "_cache_path", lambda: tmp_path / "openrouter_models.json")
    return tmp_path


def test_parse_pricing_modalities_reasoning():
    models = orc._parse_payload(_PAYLOAD)
    ids = [m.id for m in models]
    assert ids == ["vendor/chat-model", "vendor/free-model:free"]  # embedding skipped
    chat = models[0]
    assert chat.provider == "openrouter"
    assert chat.api == "openai-completions"
    assert chat.base_url == "https://openrouter.ai/api/v1"
    assert chat.cost.input == pytest.approx(0.5)  # USD/1M from per-token string
    assert chat.cost.output == pytest.approx(1.5)
    assert chat.context_window == 200000
    assert chat.reasoning is True
    assert len(chat.input) == 2  # text + image (multimodal)
    free = models[1]
    assert free.cost.input == 0.0 and free.cost.output == 0.0
    assert len(free.input) == 1  # text only


def test_fetch_uses_fresh_cache_without_network(cache_in_tmp, monkeypatch):
    orc._write_cache(_PAYLOAD)

    def _boom(*a, **k):  # network must NOT be touched when cache is fresh
        raise AssertionError("network called despite fresh cache")

    monkeypatch.setattr(orc.httpx, "get", _boom)
    models = orc.fetch_openrouter_models("k", ttl_s=10_000)
    assert {m.id for m in models} == {"vendor/chat-model", "vendor/free-model:free"}


def test_fetch_failure_falls_back_to_stale_cache(cache_in_tmp, monkeypatch):
    orc._write_cache(_PAYLOAD)

    class _Resp:
        def raise_for_status(self):
            raise RuntimeError("boom")

        def json(self):
            return {}

    monkeypatch.setattr(orc.httpx, "get", lambda *a, **k: _Resp())
    # ttl 0 forces a fetch attempt, which fails -> stale cache (any age) is used.
    models = orc.fetch_openrouter_models("k", ttl_s=0)
    assert {m.id for m in models} == {"vendor/chat-model", "vendor/free-model:free"}


def test_fetch_failure_no_cache_returns_empty(cache_in_tmp, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("no network")

    monkeypatch.setattr(orc.httpx, "get", _boom)
    assert orc.fetch_openrouter_models("k", force=True) == []  # curated set remains the fallback


def test_register_puts_models_in_registry(cache_in_tmp, monkeypatch):
    monkeypatch.setattr(
        orc, "fetch_openrouter_models", lambda *a, **k: orc._parse_payload(_PAYLOAD)
    )
    from minima_harness.ai.registry import find_model_by_id

    n = orc.register_openrouter_models("k")
    assert n == 2
    m = find_model_by_id("vendor/chat-model")
    assert m is not None and m.provider == "openrouter"


def test_live_fetch_writes_cache(cache_in_tmp, monkeypatch):
    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return _PAYLOAD

    monkeypatch.setattr(orc.httpx, "get", lambda *a, **k: _Resp())
    models = orc.fetch_openrouter_models("k", force=True)
    assert len(models) == 2
    cached = json.loads((cache_in_tmp / "openrouter_models.json").read_text())
    assert cached == _PAYLOAD  # raw payload cached for next run
