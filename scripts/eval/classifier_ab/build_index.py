"""Build the SNI task index (name -> category/definition/languages) over all ~1.6k tasks.

Two-tier: this pass is 4 KB per task. Only the tasks the sampler actually selects pay the
400 KB instance read later. Cached on disk, so this is a one-time cost.

    uv run python scripts/eval/classifier_ab/build_index.py --cache <dir> --out <json>
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sni  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()

    names = sni.task_names(args.cache)
    print(f"tasks in splits: {len(names)}", flush=True)

    done = 0
    headers: list[sni.TaskHeader] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for h in pool.map(lambda n: sni.load_header(n, args.cache), names):
            headers.append(h)
            done += 1
            if done % 200 == 0:
                print(f"  {done}/{len(names)}", flush=True)

    by_cat = collections.Counter(h.category for h in headers)
    args.out.write_text(
        json.dumps(
            [
                {
                    "name": h.name,
                    "category": h.category,
                    "definition": h.definition,
                    "domains": list(h.domains),
                    "input_language": list(h.input_language),
                    "output_language": list(h.output_language),
                }
                for h in headers
            ],
            indent=1,
        )
    )
    print(f"\ndistinct categories: {len(by_cat)}")
    for c, k in by_cat.most_common():
        print(f"{k:4d}  {c}")


if __name__ == "__main__":
    main()
