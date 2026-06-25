"""Live OpenRouter catalog: one ``OPENROUTER_API_KEY`` → all of OpenRouter's models.

OpenRouter is an aggregator — its value is *one key, hundreds of upstream models*. Hardcoding a
handful of ids (as the static catalog does) throws that away and drifts out of date. This module
fetches OpenRouter's authoritative ``GET /api/v1/models`` list, parses each entry into a harness
:class:`~minima_harness.ai.types.Model` (id, live pricing, context window, modalities, reasoning),
and registers them so any OpenRouter model is callable, pinnable, and routable.

It is **offline-safe and fast**: the response is cached to ``~/.minima-harness/cache`` with a TTL,
so only the first run (or a stale cache) touches the network, and a fetch failure falls back to the
cache, then to the static curated set — startup never blocks or breaks on a network hiccup.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx

from minima_harness.ai.types import Modality, Model, ModelCost

_log = logging.getLogger("minima_harness.ai.openrouter")

_MODELS_URL = "https://openrouter.ai/api/v1/models"
_BASE_URL = "https://openrouter.ai/api/v1"
_TEXT = (Modality.text,)
_MM = (Modality.text, Modality.image)
_CACHE_TTL_S = 24 * 3600  # refresh at most once a day
_DEFAULT_MAX_TOKENS = 8192
_FETCH_TIMEOUT_S = 12.0


def _cache_path() -> Path:
    return Path.home() / ".minima-harness" / "cache" / "openrouter_models.json"


def _to_model(entry: dict) -> Model | None:
    """Parse one OpenRouter /models entry into a harness Model (None to skip non-chat models)."""
    mid = entry.get("id")
    if not mid:
        return None
    arch = entry.get("architecture") or {}
    out_mods = arch.get("output_modalities") or ["text"]
    if "text" not in out_mods:  # skip embedding / image-gen / audio-only models
        return None
    in_mods = arch.get("input_modalities") or ["text"]
    pricing = entry.get("pricing") or {}
    # OpenRouter prices are USD per token (strings); the harness stores USD per 1M tokens.
    try:
        cost_in = float(pricing.get("prompt") or 0.0) * 1_000_000
        cost_out = float(pricing.get("completion") or 0.0) * 1_000_000
    except (TypeError, ValueError):
        cost_in = cost_out = 0.0
    top = entry.get("top_provider") or {}
    max_out = int(top.get("max_completion_tokens") or 0) or _DEFAULT_MAX_TOKENS
    supported = entry.get("supported_parameters") or []
    reasoning = "reasoning" in supported or "include_reasoning" in supported
    return Model(
        id=mid,
        provider="openrouter",
        api="openai-completions",
        name=entry.get("name") or mid,
        cost=ModelCost(input=cost_in, output=cost_out),
        context_window=int(entry.get("context_length") or 128_000),
        max_tokens=min(max_out, 32_768),
        input=_MM if "image" in in_mods else _TEXT,
        reasoning=reasoning,
        base_url=_BASE_URL,
    )


def _parse_payload(payload: dict) -> list[Model]:
    data = payload.get("data") or []
    out: list[Model] = []
    for entry in data:
        model = _to_model(entry)
        if model is not None:
            out.append(model)
    return out


def _read_cache(*, max_age_s: float | None) -> list[Model] | None:
    path = _cache_path()
    if not path.is_file():
        return None
    if max_age_s is not None and (time.time() - path.stat().st_mtime) > max_age_s:
        return None
    try:
        return _parse_payload(json.loads(path.read_text()))
    except Exception:  # noqa: BLE001 - a corrupt cache is just a miss
        return None


def _write_cache(payload: dict) -> None:
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))
    except Exception:  # noqa: BLE001 - caching is best-effort
        _log.debug("openrouter_cache_write_failed", exc_info=True)


def fetch_openrouter_models(
    api_key: str | None = None,
    *,
    timeout: float = _FETCH_TIMEOUT_S,
    ttl_s: float = _CACHE_TTL_S,
    force: bool = False,
) -> list[Model]:
    """OpenRouter's model list as harness Models. Cache-first, network-second, never raises.

    Resolution order: fresh disk cache → live fetch (then cache it) → stale cache → ``[]``.
    Returning ``[]`` lets the caller keep the static curated OpenRouter set as a last resort.
    """
    if not force:
        cached = _read_cache(max_age_s=ttl_s)
        if cached:
            return cached
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        resp = httpx.get(_MODELS_URL, headers=headers, timeout=timeout)
        resp.raise_for_status()
        payload = resp.json()
        models = _parse_payload(payload)
        if models:
            _write_cache(payload)
            return models
    except Exception:  # noqa: BLE001 - degrade to cache; the harness must still start
        _log.debug("openrouter_models_fetch_failed", exc_info=True)
    stale = _read_cache(max_age_s=None)  # any age beats nothing
    return stale or []


def register_openrouter_models(api_key: str | None = None) -> int:
    """Register OpenRouter's live model catalog into the harness registry. Returns the count.

    No-op-safe: on a fetch failure with no cache, returns 0 and the static curated OpenRouter
    models registered by :func:`register_catalog_models` remain in place.
    """
    import os

    from minima_harness.ai.registry import register_model

    key = api_key or os.environ.get("OPENROUTER_API_KEY")
    models = fetch_openrouter_models(key)
    for model in models:
        register_model(model)
    if models:
        _log.debug("registered %d openrouter models (live catalog)", len(models))
    return len(models)
