"""sync_catalog: overlay Minima /v1/models authoritative pricing onto registered models."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from minima_harness.minima.mapping import sync_catalog


@pytest.fixture(autouse=True)
def _restore_registry():
    from minima_harness.ai import registry

    snapshot = dict(registry._MODELS)
    yield
    registry._MODELS.clear()
    registry._MODELS.update(snapshot)


def _card(**kw):
    base = {
        "provider": "",
        "model_id": "",
        "input_cost_per_mtok": 0.0,
        "output_cost_per_mtok": 0.0,
        "cache_read_cost_per_mtok": None,
        "context_window": 0,
        "max_output_tokens": None,
    }
    base.update(kw)
    return SimpleNamespace(**base)


class _FakeClient:
    def __init__(self, cards, *, raises=False):
        self._cards = cards
        self._raises = raises

    def models(self, include_stale=True):
        if self._raises:
            raise RuntimeError("minima unreachable")
        return SimpleNamespace(models=self._cards)


def _register(model_id, provider, cost_in, cost_out):
    from minima_harness.ai.registry import register_model
    from minima_harness.ai.types import Model, ModelCost

    register_model(
        Model(
            id=model_id,
            provider=provider,
            api="openai-completions",
            name=model_id,
            cost=ModelCost(input=cost_in, output=cost_out),
            context_window=1000,
            max_tokens=100,
        )
    )


def test_overlay_updates_matching_model():
    _register("ov-model", "ovprov", 1.0, 2.0)
    card = _card(
        provider="ovprov",
        model_id="ov-model",
        input_cost_per_mtok=9.0,
        output_cost_per_mtok=18.0,
        cache_read_cost_per_mtok=0.5,
        context_window=5000,
        max_output_tokens=4096,
    )
    from minima_harness.ai.registry import get_model

    assert sync_catalog(_FakeClient([card])) == 1
    m = get_model("ovprov", "ov-model")
    assert m.cost.input == 9.0 and m.cost.output == 18.0
    assert m.cost.cache_read == 0.5
    assert m.context_window == 5000
    assert m.max_tokens == 4096


def test_overlay_skips_unknown_model():
    card = _card(provider="nope", model_id="nope-model", input_cost_per_mtok=1.0)
    assert sync_catalog(_FakeClient([card])) == 0


def test_overlay_resolves_by_id_when_provider_differs():
    # Minima may use a different provider string; the tolerant resolver matches on id.
    _register("xy-model", "harness-prov", 1.0, 2.0)
    card = _card(
        provider="minima-prov", model_id="xy-model", input_cost_per_mtok=4.0,
        output_cost_per_mtok=8.0,
    )
    from minima_harness.ai.registry import get_model

    assert sync_catalog(_FakeClient([card])) == 1
    assert get_model("harness-prov", "xy-model").cost.input == 4.0


def test_overlay_offline_safe_returns_zero():
    assert sync_catalog(_FakeClient([], raises=True)) == 0
