"""Build the frozen SNI evaluation set per PREREG §3.

Deterministic end to end: tasks sorted by name, categories round-robined within each gold
class so no single category dominates, seeded RNG for instance selection. Re-running
produces a byte-identical file.

    uv run python scripts/eval/classifier_ab/sample.py \
        --index <index.json> --cache <dir> --out <eval_set.jsonl>
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sni  # noqa: E402
from category_map import CATEGORY_MAP, UNMAPPABLE  # noqa: E402

SEED = 20260727
PER_TASK = 6
PER_CLASS_CAP = 400
UNMAPPABLE_CAP = 200


def _english(header: dict) -> bool:
    langs = [str(x) for x in header.get("input_language", [])]
    return langs == ["English"]


def _pick_tasks(rows: list[dict], label_of, cap_rows: int) -> dict[str, list[dict]]:
    """Round-robin tasks across the categories of each class until the row cap is met."""
    by_class: dict[str, dict[str, list[dict]]] = collections.defaultdict(
        lambda: collections.defaultdict(list)
    )
    for r in sorted(rows, key=lambda r: r["name"]):
        lab = label_of(r["category"])
        if lab is None:
            continue
        # Translation is cross-language by definition; every other class is English-input.
        if lab != "translation" and not _english(r):
            continue
        by_class[lab][r["category"]].append(r)

    picked: dict[str, list[dict]] = {}
    need_tasks = -(-cap_rows // PER_TASK)  # ceil
    for lab, cats in by_class.items():
        order = sorted(cats)
        out: list[dict] = []
        i = 0
        while len(out) < need_tasks and any(cats[c] for c in order):
            c = order[i % len(order)]
            if cats[c]:
                out.append(cats[c].pop(0))
            i += 1
        picked[lab] = out
    return picked


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", type=Path, required=True)
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    index = json.loads(args.index.read_text())
    mapped = _pick_tasks(index, CATEGORY_MAP.get, PER_CLASS_CAP)
    unmapped = _pick_tasks(
        index, lambda c: "__unmappable__" if c in UNMAPPABLE else None, UNMAPPABLE_CAP
    )
    plan = {**mapped, **unmapped}

    wanted = [(lab, t) for lab, tasks in plan.items() for t in tasks]
    print(f"tasks selected: {len(wanted)} across {len(plan)} classes", flush=True)

    def fetch(item):
        lab, t = item
        header, instances = sni.load_instances(t["name"], args.cache, cap=60)
        return lab, t, header, instances

    fetched = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for res in pool.map(fetch, wanted):
            fetched.append(res)
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(wanted)}", flush=True)

    rng = random.Random(SEED)
    per_class: collections.Counter = collections.Counter()
    out_rows: list[dict] = []
    for lab, t, header, instances in sorted(fetched, key=lambda x: x[1]["name"]):
        cap = UNMAPPABLE_CAP if lab == "__unmappable__" else PER_CLASS_CAP
        if per_class[lab] >= cap:
            continue
        usable = [i for i in instances if str(i.get("input", "")).strip()]
        if not usable:
            continue
        take = min(PER_TASK, len(usable), cap - per_class[lab])
        for inst in rng.sample(usable, take):
            out_rows.append(
                {
                    "task": t["name"],
                    "category": t["category"],
                    "label": None if lab == "__unmappable__" else lab,
                    "instance_id": str(inst.get("id", "")),
                    "definition": header.definition,
                    "input": str(inst["input"]),
                    "text": f"{header.definition.strip()}\n\n{str(inst['input']).strip()}",
                }
            )
            per_class[lab] += 1

    out_rows.sort(key=lambda r: (r["label"] or "~unmappable", r["task"], r["instance_id"]))
    with args.out.open("w") as fh:
        for r in out_rows:
            fh.write(json.dumps(r, sort_keys=True) + "\n")

    print(f"\nrows: {len(out_rows)}  ->  {args.out}")
    for lab, n in sorted(per_class.items()):
        print(f"  {lab:16s} {n}")


if __name__ == "__main__":
    main()
