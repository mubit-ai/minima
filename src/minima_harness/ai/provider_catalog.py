"""Provider catalog: where each LLM provider lives and which models it serves.

The single source of truth for multi-provider integration. Almost every provider speaks
the OpenAI Chat-Completions protocol (``POST {base_url}/chat/completions``), so the generic
:mod:`~minima_harness.ai.providers.openai_compat` provider can call all of them given a
``base_url`` and the right API-key env var — that mapping lives here.

Three things the rest of the harness reads from this module:
  - :func:`env_vars_for_provider` — provider id -> the env vars that supply its key. Used by
    ``openai_compat`` (resolve the call key for *this* model's provider) and by the offline
    fallback / candidate gating (is a model runnable with the configured keys?).
  - :func:`register_catalog_models` — register a curated, current set of models for every
    provider whose key is configured (lean: a user only sees models they can actually run).
  - :data:`PROVIDERS` / :func:`config_providers` — drive the ``minima config`` provider section.

Model ids + pricing were verified against each provider's official docs (June 2026). Native
Anthropic / Google models stay on their own SDK providers; everything else is OpenAI-compatible.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from minima_harness.ai.types import ApiId, Modality, Model, ModelCost

_TEXT = (Modality.text,)
_MM = (Modality.text, Modality.image)


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    """How to reach a provider + which key env vars supply its credential."""

    name: str
    display_name: str
    category: str  # closed-native | aggregator | open-source-host | local-runtime
    api: ApiId
    env_vars: tuple[str, ...]
    base_url: str | None = None  # OpenAI-compat base; None = native (anthropic/google) or OpenAI
    requires_key: bool = True
    show_in_config: bool = False  # surface as a field in `minima config`
    blurb: str = ""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str
    name: str
    input: float  # USD / 1M input tokens
    output: float  # USD / 1M output tokens
    context_window: int = 128_000
    max_tokens: int = 8192
    reasoning: bool = False
    multimodal: bool = False


# --------------------------------------------------------------------------- providers
# env_vars order = resolution order (first set wins). Native providers carry base_url=None.
PROVIDERS: tuple[ProviderSpec, ...] = (
    # --- closed-source / proprietary frontier APIs ---
    ProviderSpec("anthropic", "Anthropic (Claude)", "closed-native", "anthropic-messages",
                 ("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"), None, True, True,
                 "Claude — Opus / Sonnet / Haiku"),
    ProviderSpec("openai", "OpenAI", "closed-native", "openai-completions",
                 ("OPENAI_API_KEY",), None, True, True, "GPT-5.x / GPT-4o"),
    ProviderSpec("google", "Google Gemini", "closed-native", "google-generative-ai",
                 ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"), None, True, True,
                 "Gemini 2.5 / 3.5"),
    ProviderSpec("xai", "xAI (Grok)", "closed-native", "openai-completions",
                 ("XAI_API_KEY",), "https://api.x.ai/v1", True, True, "Grok 4.x"),
    ProviderSpec("deepseek", "DeepSeek", "closed-native", "openai-completions",
                 ("DEEPSEEK_API_KEY",), "https://api.deepseek.com", True, True,
                 "DeepSeek V4 (open-weight, cheap)"),
    ProviderSpec("mistral", "Mistral AI", "closed-native", "openai-completions",
                 ("MISTRAL_API_KEY",), "https://api.mistral.ai/v1", True, True,
                 "Mistral Large / Codestral"),
    ProviderSpec("cohere", "Cohere", "closed-native", "openai-completions",
                 ("COHERE_API_KEY", "CO_API_KEY"), "https://api.cohere.ai/compatibility/v1",
                 True, False, "Command A / R"),
    ProviderSpec("perplexity", "Perplexity (Sonar)", "closed-native", "openai-completions",
                 ("PERPLEXITY_API_KEY",), "https://api.perplexity.ai", True, False,
                 "Sonar — web-grounded"),
    # --- aggregator (one key, many upstream models) ---
    ProviderSpec("openrouter", "OpenRouter", "aggregator", "openai-completions",
                 ("OPENROUTER_API_KEY",), "https://openrouter.ai/api/v1", True, True,
                 "one key, 100s of open + closed models"),
    # --- open-source / open-weight inference hosts ---
    ProviderSpec("groq", "Groq", "open-source-host", "openai-completions",
                 ("GROQ_API_KEY",), "https://api.groq.com/openai/v1", True, True,
                 "very fast open-weight inference"),
    ProviderSpec("together", "Together AI", "open-source-host", "openai-completions",
                 ("TOGETHER_API_KEY",), "https://api.together.ai/v1", True, True,
                 "Llama / Qwen / DeepSeek open-weight"),
    ProviderSpec("fireworks", "Fireworks AI", "open-source-host", "openai-completions",
                 ("FIREWORKS_API_KEY",), "https://api.fireworks.ai/inference/v1", True, False,
                 "open-weight inference"),
    ProviderSpec("deepinfra", "DeepInfra", "open-source-host", "openai-completions",
                 ("DEEPINFRA_TOKEN", "DEEPINFRA_API_KEY"), "https://api.deepinfra.com/v1/openai",
                 True, False, "open-weight inference"),
    ProviderSpec("cerebras", "Cerebras", "open-source-host", "openai-completions",
                 ("CEREBRAS_API_KEY",), "https://api.cerebras.ai/v1", True, False,
                 "wafer-scale fast inference"),
    ProviderSpec("hyperbolic", "Hyperbolic", "open-source-host", "openai-completions",
                 ("HYPERBOLIC_API_KEY",), "https://api.hyperbolic.xyz/v1", True, False,
                 "open-weight inference"),
    ProviderSpec("novita", "Novita AI", "open-source-host", "openai-completions",
                 ("NOVITA_API_KEY",), "https://api.novita.ai/openai", True, False,
                 "open-weight inference"),
    # --- local / self-hosted runtimes (no key; model ids are whatever you loaded) ---
    ProviderSpec("ollama", "Ollama (local)", "local-runtime", "openai-completions",
                 ("OLLAMA_API_KEY",), "http://localhost:11434/v1", False, False,
                 "local models via Ollama"),
    ProviderSpec("lmstudio", "LM Studio (local)", "local-runtime", "openai-completions",
                 ("LMSTUDIO_API_KEY",), "http://localhost:1234/v1", False, False,
                 "local models via LM Studio"),
    ProviderSpec("vllm", "vLLM (local)", "local-runtime", "openai-completions",
                 ("VLLM_API_KEY",), "http://localhost:8000/v1", False, False, "self-hosted vLLM"),
    ProviderSpec("llamacpp", "llama.cpp (local)", "local-runtime", "openai-completions",
                 ("LLAMA_API_KEY",), "http://localhost:8080/v1", False, False,
                 "self-hosted llama-server"),
    ProviderSpec("localai", "LocalAI (local)", "local-runtime", "openai-completions",
                 ("LOCALAI_API_KEY",), "http://localhost:8080/v1", False, False,
                 "self-hosted LocalAI"),
)

_BY_NAME: dict[str, ProviderSpec] = {p.name: p for p in PROVIDERS}

# Generic fallback env vars for an unknown/custom provider (e.g. a models.json "openai-compat"
# entry). Lets a hand-rolled OpenAI-compatible endpoint resolve a key.
_GENERIC_ENV_VARS: tuple[str, ...] = ("OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY")


# --------------------------------------------------------------------------- curated models
# Verified current ids + USD/1M pricing (official docs, June 2026). The native anthropic/google
# /openai base set is seeded in registry.py; here we ADD the multi-provider catalog. Models are
# only registered for a provider once its key is configured (see register_catalog_models).
CATALOG_MODELS: dict[str, list[ModelSpec]] = {
    "openai": [
        ModelSpec("gpt-5.4-nano", "GPT-5.4 nano", 0.20, 1.25, 400_000, 16_384, multimodal=True),
        ModelSpec("gpt-5.4-mini", "GPT-5.4 mini", 0.75, 4.50, 400_000, 16_384, multimodal=True),
        ModelSpec("gpt-5.4", "GPT-5.4", 2.50, 15.0, 1_050_000, 16_384, True, True),
        ModelSpec("gpt-5.5", "GPT-5.5", 5.0, 30.0, 1_050_000, 16_384, True, True),
    ],
    "google": [
        ModelSpec("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 0.10, 0.40,
                  1_048_576, 8192, multimodal=True),
        ModelSpec("gemini-3.5-flash", "Gemini 3.5 Flash", 1.50, 9.0, 1_048_576, 8192, True, True),
    ],
    "xai": [
        ModelSpec("grok-build-0.1", "Grok Build 0.1 (coding)", 1.0, 2.0, 256_000, 16_384, True),
        ModelSpec("grok-4.3", "Grok 4.3", 1.25, 2.50, 1_000_000, 16_384, True),
    ],
    "deepseek": [
        ModelSpec("deepseek-v4-flash", "DeepSeek V4 Flash", 0.14, 0.28, 1_000_000, 16_384, True),
        ModelSpec("deepseek-v4-pro", "DeepSeek V4 Pro", 0.435, 0.87, 1_000_000, 16_384, True),
    ],
    "mistral": [
        ModelSpec("mistral-small-latest", "Mistral Small 4", 0.15, 0.60, 128_000, 8192),
        ModelSpec("codestral-latest", "Codestral (code)", 0.30, 0.90, 256_000, 16_384),
        ModelSpec("mistral-medium-latest", "Mistral Medium 3.5", 1.50, 7.50, 128_000, 8192),
    ],
    "cohere": [
        ModelSpec("command-r-08-2024", "Command R (08-2024)", 0.15, 0.60, 128_000, 4096),
        ModelSpec("command-a-03-2025", "Command A (03-2025)", 2.50, 10.0, 256_000, 8192),
    ],
    "perplexity": [
        ModelSpec("sonar", "Sonar (web-grounded)", 1.0, 1.0, 128_000, 8192),
        ModelSpec("sonar-pro", "Sonar Pro (web-grounded)", 3.0, 15.0, 200_000, 8192),
    ],
    "openrouter": [
        ModelSpec("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B (OpenRouter)",
                  0.10, 0.32, 131_072, 8192),
        ModelSpec("deepseek/deepseek-chat-v3.1", "DeepSeek V3.1 (OpenRouter)",
                  0.21, 0.79, 163_840, 8192, True),
        ModelSpec("qwen/qwen3-235b-a22b", "Qwen3 235B (OpenRouter)", 0.455, 1.82, 131_072, 8192),
        ModelSpec("meta-llama/llama-4-maverick", "Llama 4 Maverick (OpenRouter)",
                  0.15, 0.60, 1_048_576, 8192, multimodal=True),
    ],
    "groq": [
        ModelSpec("llama-3.1-8b-instant", "Llama 3.1 8B Instant (Groq)", 0.05, 0.08, 131_072, 8192),
        ModelSpec("openai/gpt-oss-120b", "GPT-OSS 120B (Groq)", 0.15, 0.60, 131_072, 8192, True),
        ModelSpec("llama-3.3-70b-versatile", "Llama 3.3 70B (Groq)", 0.59, 0.79, 131_072, 8192),
    ],
    "together": [
        ModelSpec("openai/gpt-oss-120b", "GPT-OSS 120B (Together)",
                  0.15, 0.60, 131_072, 8192, True),
        ModelSpec("Qwen/Qwen3-235B-A22B-Instruct-2507-tput", "Qwen3 235B (Together)",
                  0.20, 0.60, 262_144, 8192),
        ModelSpec("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B (Together)",
                  1.04, 1.04, 131_072, 8192),
    ],
    "fireworks": [
        ModelSpec("accounts/fireworks/models/gpt-oss-120b", "GPT-OSS 120B (Fireworks)",
                  0.15, 0.60, 131_072, 8192, True),
        ModelSpec("accounts/fireworks/models/qwen3-235b-a22b-instruct-2507",
                  "Qwen3 235B (Fireworks)", 0.22, 0.88, 262_144, 8192),
    ],
    "deepinfra": [
        ModelSpec("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B (DeepInfra)",
                  0.10, 0.32, 131_072, 8192),
        ModelSpec("deepseek-ai/DeepSeek-V4-Flash", "DeepSeek V4 Flash (DeepInfra)",
                  0.10, 0.20, 1_000_000, 16_384, True),
    ],
    "cerebras": [
        ModelSpec("gpt-oss-120b", "GPT-OSS 120B (Cerebras)", 0.35, 0.75, 131_072, 8192, True),
    ],
    "hyperbolic": [
        ModelSpec("deepseek-ai/DeepSeek-V3", "DeepSeek V3 (Hyperbolic)", 0.25, 0.25, 131_072, 8192),
        ModelSpec("meta-llama/Llama-3.3-70B-Instruct", "Llama 3.3 70B (Hyperbolic)",
                  0.40, 0.40, 131_072, 8192),
    ],
    "novita": [
        ModelSpec("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B (Novita)",
                  0.135, 0.40, 131_072, 8192),
        ModelSpec("deepseek/deepseek-v3", "DeepSeek V3 (Novita)", 0.27, 1.12, 163_840, 8192),
    ],
}


# --------------------------------------------------------------------------- helpers
def spec_for(provider: str) -> ProviderSpec | None:
    return _BY_NAME.get(provider.lower())


def env_vars_for_provider(provider: str) -> tuple[str, ...]:
    """Env vars that supply ``provider``'s API key (resolution order). Unknown/custom
    providers fall back to the generic OpenAI-compat vars so a models.json entry still works."""
    spec = _BY_NAME.get(provider.lower())
    return spec.env_vars if spec else _GENERIC_ENV_VARS


def provider_key_present(provider: str) -> bool:
    """True if a key for ``provider`` is set, or it needs none (local runtime)."""
    spec = _BY_NAME.get(provider.lower())
    if spec is not None and not spec.requires_key:
        return True
    return any(os.environ.get(v) for v in env_vars_for_provider(provider))


def configured_providers() -> list[str]:
    """Provider ids whose key is currently configured (in resolution-order env)."""
    return [p.name for p in PROVIDERS if p.requires_key and provider_key_present(p.name)]


def config_providers() -> list[ProviderSpec]:
    """Providers surfaced as fields in ``minima config`` (curated, popular subset)."""
    return [p for p in PROVIDERS if p.show_in_config]


def runnable_candidates(candidate_ids: list[str]) -> list[str]:
    """Filter routing candidates to models whose provider key is configured, so Minima is
    never asked to choose a model the user cannot call. Unknown ids are kept (Minima may know
    them). Returns the original list if none are runnable, so routing still yields a clear
    auth error rather than an empty candidate set."""
    from minima_harness.ai.registry import find_model_by_id

    out: list[str] = []
    for cid in candidate_ids:
        model = find_model_by_id(cid)
        if model is None or provider_key_present(model.provider):
            out.append(cid)
    return out or list(candidate_ids)


def _to_model(provider: str, spec: ProviderSpec, m: ModelSpec) -> Model:
    return Model(
        id=m.id,
        provider=provider,
        api=spec.api,
        name=m.name,
        cost=ModelCost(input=m.input, output=m.output),
        context_window=m.context_window,
        max_tokens=m.max_tokens,
        input=_MM if m.multimodal else _TEXT,
        reasoning=m.reasoning,
        base_url=spec.base_url,
    )


def register_catalog_models(*, present_keys_only: bool = True) -> list[str]:
    """Register the curated catalog models, by default only for providers whose key is set.

    Keeps the registry (and the model picker) lean: a user sees models they can actually run.
    Returns the list of provider ids that were registered. The native anthropic/google/openai
    base models are seeded separately in :mod:`registry` and are unaffected."""
    from minima_harness.ai.registry import register_model

    registered: list[str] = []
    for provider, models in CATALOG_MODELS.items():
        spec = _BY_NAME.get(provider)
        if spec is None:
            continue
        if present_keys_only and spec.requires_key and not provider_key_present(provider):
            continue
        for m in models:
            register_model(_to_model(provider, spec, m))
        registered.append(provider)
    return registered
