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
    return cards, raw.get("version", "fallback-snapshot")


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
