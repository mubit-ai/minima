"""Map a Minima ``RankedModel`` to a harness :class:`~minima_harness.ai.types.Model`.

Minima's catalog and the harness registry are kept deliberately separate: Minima is the
source of truth for *routing*, the harness registry for *calling*. This module bridges
them with a tolerant lookup (exact -> id-only -> ``provider/model`` split -> fallback) so
a recommendation resolves to a callable model even when ids drift slightly between the
two catalogs.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from minima_harness.ai.provider_catalog import provider_key_present
from minima_harness.ai.registry import all_models, find_model_by_id, try_get_model
from minima_harness.ai.types import Model

if TYPE_CHECKING:
    from minima.schemas.recommend import RankedModel

_log = logging.getLogger("minima_harness.mapping")


def _has_provider_key(model: Model) -> bool:
    """True if a key for ``model``'s OWN provider is set (or it needs none, e.g. a local runtime).

    Provider-specific (via the provider catalog): a Groq model needs GROQ_API_KEY, an OpenAI
    model needs OPENAI_API_KEY — an OpenRouter key never green-lights an api.openai.com model.
    """
    return provider_key_present(model.provider)


def _fallback_cost(model: Model) -> float:
    """Sort key for the offline fallback: combined per-token cost, but treat an unpriced
    (cost 0) model as most-expensive so a local/custom 0-cost stub isn't mistaken for the
    cheapest runnable default."""
    total = model.cost.input + model.cost.output
    return float("inf") if total <= 0 else total


class ModelMapping:
    """Resolve Minima's pick to a callable harness model."""

    def to_model(
        self,
        ranked: RankedModel,
        *,
        offline_default: Model | None = None,
    ) -> Model:
        model = self._resolve(ranked.provider, ranked.model_id)
        if model is not None:
            return model
        if offline_default is not None:
            _log.debug(
                "mapping_fallback_to_offline_default provider=%s model_id=%s",
                ranked.provider,
                ranked.model_id,
            )
            return offline_default
        raise KeyError(
            f"no harness model for minima pick {ranked.provider}/{ranked.model_id!r}; "
            "register it or pass an offline_default"
        )

    def default_model(self) -> Model:
        """Offline fallback: the cheapest registered model the user can actually run.

        Prefers the cheapest model whose provider key is configured, so an offline
        fallback doesn't pick (say) gpt-4o-mini when only Anthropic/Gemini keys are set.
        Falls back to the globally cheapest model if no provider key is present (the run
        will then surface a clear provider-auth error rather than a silent mismatch)."""
        models = all_models()
        if not models:
            raise KeyError("harness model registry is empty")
        by_cost = sorted(models, key=lambda m: (_fallback_cost(m), m.id))
        for model in by_cost:
            if _has_provider_key(model):
                return model
        return by_cost[0]

    def _resolve(self, provider: str, model_id: str) -> Model | None:
        # 1. exact (provider, id)
        model = try_get_model(provider, model_id)
        if model is not None:
            return model
        # 2. id-only (Minima's provider string may differ from ours)
        model = find_model_by_id(model_id)
        if model is not None:
            return model
        # 3. openrouter-style "provider/model" ids
        if "/" in model_id:
            prov, _, mid = model_id.partition("/")
            model = (
                try_get_model(prov, model_id) or try_get_model(prov, mid) or find_model_by_id(mid)
            )
            if model is not None:
                return model
        return None


def sync_catalog(client: object, mapping: ModelMapping | None = None) -> None:
    """Pull ``GET /v1/models`` from Minima and (future) reconcile prices into the registry.

    Phase 3 stub: the harness registry remains authoritative for calling. Real catalog
    merging lands when the price-drift reconciliation rules are settled.
    """
    _ = client, mapping  # placeholder; intentionally a no-op for now
