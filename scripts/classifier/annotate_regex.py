"""Annotate a corpus with the regex heuristic's vote (classifier program, corpus
iteration): adds a "regex" field per row for train.py's regex-as-feature head. Runs in
the REPO venv (imports minima, no heavy deps):

  uv run python scripts/classifier/annotate_regex.py --corpus corpus.jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from minima.recommender.classify import infer_task_type


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, required=True)
    args = ap.parse_args()
    rows = [json.loads(line) for line in args.corpus.open()]
    for r in rows:
        r["regex"] = infer_task_type(r["text"]).value
    with args.corpus.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"annotated {len(rows)} rows with regex votes")


if __name__ == "__main__":
    main()
