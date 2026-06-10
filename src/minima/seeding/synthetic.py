"""Deterministic synthetic seed data.

Generates plausible (task -> model -> outcome) records where cheaper/weaker models
succeed on easy tasks and fail on hard ones. Useful for smoke-testing the full
ingest -> recall -> reinforce loop without network or an external dataset.
"""

from __future__ import annotations

import random

from minima.catalog.store import load_snapshot_cards
from minima.memory.keys import build_content, task_cluster, task_fingerprint
from minima.memory.records import OutcomeRecord
from minima.schemas.common import Difficulty, TaskType
from minima.seeding.items import SeedItem

_DIFFICULTY_REQUIREMENT = {
    Difficulty.easy: 0.5,
    Difficulty.medium: 0.7,
    Difficulty.hard: 0.85,
}


def generate(n: int, seed: int = 42) -> list[SeedItem]:
    cards, _ = load_snapshot_cards()
    rng = random.Random(seed)
    task_types = list(TaskType)
    difficulties = list(_DIFFICULTY_REQUIREMENT)
    out: list[SeedItem] = []

    for i in range(n):
        task_type = rng.choice(task_types)
        difficulty = rng.choice(difficulties)
        card = rng.choice(cards)

        text = (
            f"Synthetic {task_type.value} task #{i} at {difficulty.value} difficulty: "
            f"handle the {task_type.value} request described here."
        )
        prior = card.capability_by_task_type.get(task_type, 0.5)
        success = prior >= _DIFFICULTY_REQUIREMENT[difficulty]
        quality = 0.9 if success else 0.2
        cost = (1200 / 1_000_000) * card.input_cost_per_mtok + (
            400 / 1_000_000
        ) * card.output_cost_per_mtok

        record = OutcomeRecord(
            model_id=card.model_id,
            provider=card.provider,
            task_type=task_type.value,
            difficulty=difficulty.value,
            task_fingerprint=task_fingerprint(text),
            task_cluster=task_cluster(task_type.value, difficulty.value),
            input_tokens=1200,
            output_tokens=400,
            cost_usd=round(cost, 6),
            quality_score=quality,
            outcome="success" if success else "failure",
            source_dataset="synthetic",
        )
        out.append(
            SeedItem(
                item_id=f"syn-{i}",
                content=build_content(task_type.value, difficulty.value, text),
                record=record,
                env_tags=["seed:synthetic"],
            )
        )
    return out
