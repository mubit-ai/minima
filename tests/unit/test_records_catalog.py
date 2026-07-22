from __future__ import annotations

import json

import pytest

from minima.catalog.merge import overlay_litellm
from minima.catalog.store import (
    CatalogStore,
    apply_benchmark_priors,
    load_aliases,
    load_benchmark_priors,
    load_snapshot_cards,
)
from minima.config import Settings
from minima.memory.records import (
    OutcomeRecord,
    is_labeled,
    label_score,
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


def test_label_score_and_signal_mapping():
    # Supplied quality wins; without one the outcome's Bernoulli label applies at
    # READ time only — a default is never persisted (the old 0.9 fabrication).
    assert label_score("success", None) == pytest.approx(1.0)
    assert label_score("partial", None) == pytest.approx(0.5)
    assert label_score("failure", None) == pytest.approx(0.0)
    assert label_score("failure", 0.3) == pytest.approx(0.3)
    assert signal_from_outcome("success", 0.9) == pytest.approx(1.0)
    assert signal_from_outcome("failure", 0.0) == pytest.approx(-1.0)
    assert signal_from_outcome("failure", None) == pytest.approx(-1.0)
    assert -1.0 <= signal_from_outcome("partial", 0.5) <= 1.0


def test_evidence_source_labeling():
    assert is_labeled("gate") and is_labeled("judge") and is_labeled("human")
    assert is_labeled("dataset")
    assert not is_labeled("none")


def test_from_metadata_legacy_provenance_derivation():
    base = {"kind": "outcome", "model_id": "m", "outcome": "success", "quality_score": 0.9}
    # Legacy organic record (pre-v3, no evidence_source): quality may be fabricated —
    # demoted to telemetry.
    legacy = OutcomeRecord.from_metadata(json.dumps(base))
    assert legacy is not None and legacy.evidence_source == "none"
    # Legacy seeds are trustworthy by construction.
    seed = OutcomeRecord.from_metadata(json.dumps({**base, "source_dataset": "routerbench"}))
    assert seed is not None and seed.evidence_source == "dataset"
    # Legacy gate-verified records were only ever written from green gates.
    gated = OutcomeRecord.from_metadata(json.dumps({**base, "verified_in_production": True}))
    assert gated is not None and gated.evidence_source == "gate"
    # v3 records carry provenance explicitly and are not re-derived.
    v3 = OutcomeRecord.from_metadata(json.dumps({**base, "evidence_source": "judge"}))
    assert v3 is not None and v3.evidence_source == "judge"


def test_from_metadata_quality_absent_stays_none():
    meta = {"kind": "outcome", "model_id": "m", "outcome": "success", "evidence_source": "gate"}
    rec = OutcomeRecord.from_metadata(json.dumps(meta))
    assert rec is not None
    assert rec.quality_score is None
    assert label_score(rec.outcome, rec.quality_score) == pytest.approx(1.0)


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
    # craft a litellm entry for a SAME-model alias (cross-generation aliases are
    # forbidden -- another generation's prices must never overlay a current id)
    litellm_map = {
        "anthropic/claude-haiku-4.5": {
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


def test_catalog_covers_every_task_type_with_valid_scores():
    from minima.schemas.common import TaskType

    cards, _ = load_snapshot_cards()
    # July 2026 lineup: 12 legacy + 13 new (anthropic/openai/google/xai/deepseek/openrouter).
    assert len(cards) >= 25
    for card in cards:
        assert set(card.capability_by_task_type) == set(TaskType), card.model_id
        for task_type, score in card.capability_by_task_type.items():
            assert 0.0 <= score <= 1.0, f"{card.model_id}:{task_type}={score}"
        ii = card.capability_priors.get("intelligence_index")
        assert ii is not None and 0.0 <= ii <= 1.0, card.model_id


def test_benchmark_priors_mirror_catalog_ids():
    # Every catalog model must have a benchmark-priors entry (and vice versa) so the
    # overlay never silently skips a new model back to hand-authored priors.
    cards, _ = load_snapshot_cards()
    overlay, version = load_benchmark_priors()
    assert version
    assert set(overlay) == {c.model_id for c in cards}


def test_every_catalog_model_has_alias_entry_for_price_overlay():
    # A card with no alias row can never match the LiteLLM price map, so its price
    # stays frozen at the snapshot values (the gap that hid the gemini-3.x cards).
    cards, _ = load_snapshot_cards()
    aliases = load_aliases()
    for card in cards:
        keys = aliases.get(card.model_id)
        assert keys, f"{card.model_id} has no model_aliases.json entry"
        assert card.model_id in keys


def test_benchmark_priors_overlay_stamps_provenance():
    cards, _ = load_snapshot_cards()
    haiku = next(c for c in cards if c.model_id == "claude-haiku-4-5")
    # Capability beliefs come from the ONE versioned, refreshable overlay — not the
    # hand-authored snapshot — and say so.
    assert haiku.capability_source.startswith("benchmark-priors:")
    assert haiku.capability_by_task_type.get("code") is not None


def test_benchmark_priors_zero_overlap_fails_loudly():
    from minima.schemas.models_catalog import ModelCard

    stranger = ModelCard(
        model_id="totally-unknown-model",
        provider="acme",
        input_cost_per_mtok=1.0,
        output_cost_per_mtok=1.0,
    )
    with pytest.raises(RuntimeError, match="no model ids"):
        apply_benchmark_priors([stranger])


def test_routerbench_seeding_requires_catalog_overlap(monkeypatch):
    from minima.seeding import routerbench

    class _FakeDf:
        columns = ["prompt", "eval_name", "old-model", "old-model|total_cost"]

        def itertuples(self, index=False):
            return iter([("2+2?", "gsm8k", 1.0, 0.001)])

    monkeypatch.setattr(routerbench, "load_routerbench_df", lambda split="0shot": _FakeDf())
    # Zero overlap with the catalog -> loud failure, never a silent no-op seed.
    with pytest.raises(RuntimeError, match="no models with the live catalog"):
        routerbench.load_records(10, {}, catalog_ids={"claude-haiku-4-5"})
    # A dataset model present verbatim in the catalog still seeds.
    items = routerbench.load_records(10, {}, catalog_ids={"old-model"})
    assert len(items) == 1
    assert items[0].record.model_id == "old-model"
    assert items[0].record.evidence_source == "dataset"
