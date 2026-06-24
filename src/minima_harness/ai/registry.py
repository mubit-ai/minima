"""Model registry: ``get_model(provider, id)`` and discovery helpers.

The seed table covers the candidate set Minima's example agents route over plus a few
OpenAI/OpenRouter entries. Prices (per-million-token USD) are sourced from the comments
in ``examples/agent_warmup.py`` so the harness agrees with Minima's existing catalog
expectations out of the box; Phase 3's mapping layer reconciles against Minima's live
``GET /v1/models`` catalog where they diverge.

PI exposes ~25 providers; this lean port starts with 4 (anthropic, google, openai,
openrouter) and is extensible via :func:`register_model`.
"""

from __future__ import annotations

from minima_harness.ai.types import Modality, Model, ModelCost

# (provider, model_id) -> Model
_MODELS: dict[tuple[str, str], Model] = {}


def register_model(model: Model) -> Model:
    _MODELS[(model.provider, model.id)] = model
    return model


def get_model(provider: str, model_id: str) -> Model:
    try:
        return _MODELS[(provider, model_id)]
    except KeyError:
        known = ", ".join(f"{p}/{m}" for p, m in sorted(_MODELS)) or "<none>"
        raise KeyError(f"unknown model {provider}/{model_id!r}; known: {known}") from None


def try_get_model(provider: str, model_id: str) -> Model | None:
    return _MODELS.get((provider, model_id))


def get_models(provider: str) -> list[Model]:
    return [m for (p, _), m in _MODELS.items() if p == provider]


def get_providers() -> list[str]:
    return sorted({p for p, _ in _MODELS})


def all_models() -> list[Model]:
    return list(_MODELS.values())


def find_model_by_id(model_id: str) -> Model | None:
    """First registered model with the given id (any provider). Used by cross-provider
    compat to infer which api produced a replayed assistant message."""
    for (__, mid), model in _MODELS.items():
        if mid == model_id:
            return model
    return None


# ---------------------------------------------------------------------------
# Seed catalog
# ---------------------------------------------------------------------------

_TEXT = (Modality.text,)
_MULTIMODAL = (Modality.text, Modality.image)

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _seed() -> None:
    # --- Anthropic (api: anthropic-messages) ---
    register_model(
        Model(
            id="claude-haiku-4-5",
            provider="anthropic",
            api="anthropic-messages",
            name="Claude Haiku 4.5",
            cost=ModelCost(input=1.0, output=5.0, cache_read=0.08, cache_write=1.25),
            context_window=200_000,
            max_tokens=8192,
            input=_MULTIMODAL,
            reasoning=False,
        )
    )
    register_model(
        Model(
            id="claude-sonnet-4-6",
            provider="anthropic",
            api="anthropic-messages",
            name="Claude Sonnet 4.6",
            cost=ModelCost(input=3.0, output=15.0, cache_read=0.30, cache_write=3.75),
            context_window=200_000,
            max_tokens=16_384,
            input=_MULTIMODAL,
            reasoning=True,
        )
    )
    register_model(
        Model(
            id="claude-opus-4-8",
            provider="anthropic",
            api="anthropic-messages",
            name="Claude Opus 4.8",
            cost=ModelCost(input=15.0, output=75.0, cache_read=1.50, cache_write=18.75),
            context_window=200_000,
            max_tokens=16_384,
            input=_MULTIMODAL,
            reasoning=True,
        )
    )

    # --- Google / Gemini (api: google-generative-ai) ---
    register_model(
        Model(
            id="gemini-2.5-flash",
            provider="google",
            api="google-generative-ai",
            name="Gemini 2.5 Flash",
            cost=ModelCost(input=0.30, output=2.50),
            context_window=1_000_000,
            max_tokens=8192,
            input=_MULTIMODAL,
            reasoning=True,
        )
    )
    register_model(
        Model(
            id="gemini-2.5-pro",
            provider="google",
            api="google-generative-ai",
            name="Gemini 2.5 Pro",
            cost=ModelCost(input=1.25, output=10.0),
            context_window=2_000_000,
            max_tokens=8192,
            input=_MULTIMODAL,
            reasoning=True,
        )
    )

    # --- OpenAI (api: openai-completions via raw httpx in Phase 1) ---
    register_model(
        Model(
            id="gpt-4o-mini",
            provider="openai",
            api="openai-completions",
            name="GPT-4o mini",
            cost=ModelCost(input=0.15, output=0.60, cache_read=0.075),
            context_window=128_000,
            max_tokens=16_384,
            input=_MULTIMODAL,
            reasoning=False,
        )
    )
    register_model(
        Model(
            id="gpt-4o",
            provider="openai",
            api="openai-completions",
            name="GPT-4o",
            cost=ModelCost(input=2.5, output=10.0, cache_read=1.25),
            context_window=128_000,
            max_tokens=16_384,
            input=_MULTIMODAL,
            reasoning=False,
        )
    )

    # --- OpenRouter (api: openai-completions; base_url set) ---
    register_model(
        Model(
            id="google/gemini-2.5-flash",
            provider="openrouter",
            api="openai-completions",
            name="Gemini 2.5 Flash (OpenRouter)",
            cost=ModelCost(input=0.30, output=2.50),
            context_window=1_000_000,
            max_tokens=8192,
            input=_MULTIMODAL,
            reasoning=True,
            base_url=_OPENROUTER_BASE,
        )
    )


_seed()
