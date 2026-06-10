"""Build Mubit batch_insert items from outcome records.

``metadata_json`` must be a JSON *string* on the batch_insert wire (unlike remember(),
which JSON-encodes a dict for you). ``embedding: []`` lets the server embed on ingest.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from minima.memory.records import OutcomeRecord


@dataclass(slots=True)
class SeedItem:
    item_id: str
    content: str
    record: OutcomeRecord
    env_tags: list[str]


def build_item(seed: SeedItem, source: str = "system") -> dict:
    return {
        "item_id": seed.item_id,
        "text": seed.content,
        "metadata_json": json.dumps(seed.record.to_metadata()),
        "source": source,
        "embedding": [],
        "env_tags": list(seed.env_tags),
    }


def chunked(items: Sequence[dict], size: int) -> list[list[dict]]:
    return [list(items[i : i + size]) for i in range(0, len(items), size)]
