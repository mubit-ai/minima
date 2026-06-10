"""CLI: ``minima-seed`` — bulk-load cold-start outcome records into Mubit."""

from __future__ import annotations

import argparse
import asyncio

from minima.catalog.store import load_aliases
from minima.config import get_settings
from minima.memory.adapter import MubitMemory
from minima.seeding import routerbench, synthetic
from minima.seeding.items import SeedItem, build_item, chunked


def _load(dataset: str, limit: int) -> list[SeedItem]:
    if dataset == "synthetic":
        return synthetic.generate(limit)
    return routerbench.load_records(limit, load_aliases())


async def _seed(args: argparse.Namespace) -> None:
    settings = get_settings()
    memory = MubitMemory(settings)
    lane = args.lane or settings.minima_seed_lane

    seeds = _load(args.dataset, args.limit)
    items = [build_item(s) for s in seeds]
    print(f"prepared {len(items)} records from '{args.dataset}' -> lane '{lane}'")

    if args.dry_run:
        for item in items[:3]:
            print(item)
        print("dry-run: nothing written")
        return

    inserted = 0
    for batch in chunked(items, args.chunk):
        result = await memory.batch_insert(run_id=lane, items=batch, deduplicate=True)
        inserted += int(result.get("count", 0))
        print(f"inserted {inserted}/{len(items)}")
    print(f"done: {inserted} records into lane '{lane}'")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed Minima cold-start memory into Mubit.")
    parser.add_argument("--dataset", choices=["routerbench", "synthetic"], default="routerbench")
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--lane", default=None, help="memory lane (default: MINIMA_SEED_LANE)")
    parser.add_argument("--chunk", type=int, default=200)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    asyncio.run(_seed(args))


if __name__ == "__main__":
    main()
