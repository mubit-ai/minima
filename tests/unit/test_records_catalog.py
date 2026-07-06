from __future__ import annotations

import json

import pytest

from minima.catalog.merge import overlay_litellm
from minima.catalog.store import CatalogStore, load_aliases, load_snapshot_cards
from minima.config import Settings
from minima.memory.records import (
    OutcomeRecord,
    quality_from_outcome,
    signal_from_outcome,
)


def test_outcome_record_metadata_roundtrip():
    rec = OutcomeRecord(
        model_id="claude-haiku-4-5",
        task_type="code",
        difficulty="hard",
        task_cluster="code:hard",
        input_tokens=850,
        output_tokens=2400,
        quality_score=0.82,
        outcome="success",
        cost_usd=0.0123,
    )
    meta = rec.to_metadata()
    parsed = OutcomeRecord.from_metadata(json.dumps(meta))
    assert parsed is not None
    assert parsed.model_id == "claude-haiku-4-5"
    assert parsed.quality_score == pytest.approx(0.82)
    assert parsed.outcome == "success"
    # tokens round-trip so the engine can re-scale observed cost to the current request
    assert parsed.input_tokens == 850
    assert parsed.output_tokens == 2400
    assert parsed.cost_usd == pytest.approx(0.0123)


def test_from_metadata_rejects_non_outcome():
    assert OutcomeRecord.from_metadata(json.dumps({"kind": "lesson"})) is None
    assert OutcomeRecord.from_metadata(json.dumps({"kind": "outcome"})) is None  # no model_id
    assert OutcomeRecord.from_metadata("not json") is None
    assert OutcomeRecord.from_metadata(None) is None


def test_quality_and_signal_mapping():
    assert quality_from_outcome("success", None) == pytest.approx(0.9)
    assert quality_from_outcome("failure", 0.3) == pytest.approx(0.3)
    assert signal_from_outcome("success", 0.9) == pytest.approx(1.0)
    assert signal_from_outcome("failure", 0.0) == pytest.approx(-1.0)
    assert -1.0 <= signal_from_outcome("partial", 0.5) <= 1.0


def test_snapshot_loads_and_is_stale():
    cards, version = load_snapshot_cards()
    assert len(cards) >= 5
    assert version
    store = CatalogStore(Settings(mubit_api_key="t"))
    assert store.get().stale is True  # fallback snapshot is always stale until refreshed


def test_snapshot_json_shape_is_loader_contract():
    # Pins the exact contract the CI catalog-snapshot refresh (jq normalization in
    # .github/workflows/catalog-snapshot.yml) must keep producing so an automated
    # rewrite of the vendored snapshot can never break load_snapshot_cards().
    from importlib.resources import files

    raw = json.loads(
        files("minima.catalog").joinpath("data", "capability_priors.json").read_text("utf-8")
    )
    assert isinstance(raw.get("version"), str) and raw["version"]
    models = raw.get("models")
    assert isinstance(models, list) and len(models) >= 5
    for m in models:
        # Required (non-defaulted) keys the loader indexes directly.
        for key in ("model_id", "provider", "input_cost_per_mtok", "output_cost_per_mtok"):
            assert key in m, f"snapshot model missing required key {key!r}: {m}"
        assert isinstance(m["input_cost_per_mtok"], int | float)
        assert isinstance(m["output_cost_per_mtok"], int | float)
    # No stray runtime-metadata leaked into the vendored snapshot: those fields are
    # re-stamped by the loader and the refresh must strip them.
    assert not any(
        k in m
        for m in models
        for k in ("cost_source", "cost_fetched_at", "cost_stale", "capability_source")
    )


def test_overlay_litellm_converts_per_token_to_per_mtok():
    cards, _ = load_snapshot_cards()
    aliases = load_aliases()
    # craft a litellm entry for one known alias of haiku
    litellm_map = {
        "claude-3-5-haiku-20241022": {
            "input_cost_per_token": 0.000001,  # -> 1.0 / Mtok
            "output_cost_per_token": 0.000005,  # -> 5.0 / Mtok
            "max_input_tokens": 200000,
        }
    }
    new_cards, updated = overlay_litellm(cards, litellm_map, aliases)
    assert updated == 1
    haiku = next(c for c in new_cards if c.model_id == "claude-haiku-4-5")
    assert haiku.input_cost_per_mtok == pytest.approx(1.0)
    assert haiku.output_cost_per_mtok == pytest.approx(5.0)
    assert haiku.cost_source == "litellm"
    assert haiku.cost_stale is False
