"""In-memory model catalog snapshot, atomically swappable on refresh."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files

from minima.config import Settings
from minima.schemas.models_catalog import ModelCard


def _data_text(name: str) -> str:
    return files("minima.catalog").joinpath("data", name).read_text(encoding="utf-8")


def load_aliases() -> dict[str, list[str]]:
    raw = json.loads(_data_text("model_aliases.json"))
    return raw.get("aliases", {})


def load_benchmark_priors() -> tuple[dict[str, dict], str]:
    """The versioned capability-prior overlay: model_id -> {by_task_type, priors}.

    This is the ONE refreshable source of cold-start capability beliefs — the
    catalog-snapshot refresh replaces its contents with benchmark-derived scores.
    Returns ({} , "") when the file is absent (overlay is additive).
    """
    try:
        raw = json.loads(_data_text("benchmark_priors.json"))
    except FileNotFoundError:
        return {}, ""
    return raw.get("models", {}), str(raw.get("version", ""))


def apply_benchmark_priors(cards: list[ModelCard]) -> list[ModelCard]:
    """Overlay per-task-type priors onto the cards, stamping provenance.

    Fails loudly (raises) when the overlay shares ZERO model ids with the catalog —
    a silently-empty prior overlay is exactly the no-op cold-start failure the old
    seeding path shipped for months. Unknown overlay ids are individually skipped.
    """
    overlay, version = load_benchmark_priors()
    if not overlay:
        return cards
    by_id = {c.model_id: c for c in cards}
    matched = 0
    for model_id, entry in overlay.items():
        card = by_id.get(model_id)
        if card is None:
            continue
        matched += 1
        if entry.get("by_task_type"):
            card.capability_by_task_type = dict(entry["by_task_type"])
        if entry.get("priors"):
            card.capability_priors = dict(entry["priors"])
        card.capability_source = f"benchmark-priors:{version}"
    if matched == 0:
        raise RuntimeError(
            "benchmark_priors.json shares no model ids with the catalog — the prior "
            "overlay would be a silent no-op; fix the overlay or the catalog snapshot"
        )
    return cards


def load_snapshot_cards() -> tuple[list[ModelCard], str]:
    raw = json.loads(_data_text("capability_priors.json"))
    cards: list[ModelCard] = []
    for m in raw.get("models", []):
        cards.append(
            ModelCard(
                model_id=m["model_id"],
                provider=m["provider"],
                display_name=m.get("display_name", ""),
                input_cost_per_mtok=m["input_cost_per_mtok"],
                output_cost_per_mtok=m["output_cost_per_mtok"],
                cache_read_cost_per_mtok=m.get("cache_read_cost_per_mtok"),
                supports_prompt_caching=m.get("supports_prompt_caching", False),
                context_window=m.get("context_window", 0),
                max_output_tokens=m.get("max_output_tokens"),
                capability_priors=m.get("capability_priors", {}),
                capability_by_task_type=m.get("capability_by_task_type", {}),
                cost_source="fallback-snapshot",
                cost_fetched_at=None,
                cost_stale=True,
                capability_source="fallback-snapshot",
            )
        )
    return apply_benchmark_priors(cards), raw.get("version", "fallback-snapshot")


@dataclass(slots=True)
class Catalog:
    cards: list[ModelCard]
    version: str
    refreshed_at: datetime | None
    cost_source: str
    stale_after_seconds: int = 86_400

    def by_id(self) -> dict[str, ModelCard]:
        return {c.model_id: c for c in self.cards}

    @property
    def stale(self) -> bool:
        if self.cost_source == "fallback-snapshot" or self.refreshed_at is None:
            return True
        age = (datetime.now(UTC) - self.refreshed_at).total_seconds()
        return age > self.stale_after_seconds


class CatalogStore:
    """Holds the current catalog; reads are lock-free (atomic pointer swap)."""

    def __init__(self, settings: Settings):
        self._settings = settings
        cards, version = load_snapshot_cards()
        self._catalog = Catalog(
            cards=cards,
            version=version,
            refreshed_at=None,
            cost_source="fallback-snapshot",
            stale_after_seconds=settings.minima_catalog_stale_after_seconds,
        )

    def get(self) -> Catalog:
        return self._catalog

    def set(self, catalog: Catalog) -> None:
        self._catalog = catalog
