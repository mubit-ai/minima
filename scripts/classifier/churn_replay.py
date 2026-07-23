# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "tokenizers>=0.15"]
# ///
"""Churn-replay diagnostic (classifier program PR-6, per the program decision: a
DIAGNOSTIC with a review trigger, never a blocking gate).

Replays a corpus of prompts through the regex classifier and a trained artifact and
reports relabel fractions — overall, and among rows the regex did NOT call `other`
(the slice where relabeling means a populated cell's statistics migrate). A non-other
relabel fraction above the review threshold prints a loud REVIEW line; big corrections
stay possible, but never silent.

Run inside the repo so the regex side imports:
  uv run python scripts/classifier/churn_replay.py --artifact <dir> --corpus <jsonl>
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

REVIEW_THRESHOLD = 0.15


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifact", type=Path, required=True)
    ap.add_argument("--corpus", type=Path, required=True, help="jsonl with a 'text' field")
    args = ap.parse_args()

    from minima.recommender.classify import infer_task_type
    from minima.recommender.classify_embed import load_embed_classifier

    clf = load_embed_classifier(str(args.artifact), required=True)
    texts = [json.loads(line)["text"] for line in args.corpus.open()]

    moved = Counter()
    total = non_other = non_other_moved = relabeled = abstained = 0
    for t in texts:
        old = infer_task_type(t).value
        res = clf.classify(t)
        new = old if res.abstained else res.task_type.value
        total += 1
        abstained += int(res.abstained)
        if new != old:
            relabeled += 1
            moved[f"{old}->{new}"] += 1
        if old != "other":
            non_other += 1
            non_other_moved += int(new != old)

    print(f"classifier: {clf.classifier_id} | rows: {total}")
    print(f"relabeled overall: {relabeled}/{total} = {relabeled / total:.1%}")
    print(f"abstained (regex kept): {abstained}/{total} = {abstained / total:.1%}")
    frac = non_other_moved / non_other if non_other else 0.0
    print(f"relabeled among regex-non-other: {non_other_moved}/{non_other} = {frac:.1%}")
    print("top moves:", moved.most_common(10))
    if frac > REVIEW_THRESHOLD:
        print(
            f"REVIEW: non-other relabel {frac:.1%} exceeds {REVIEW_THRESHOLD:.0%} — "
            "inspect the top moves above before flipping (diagnostic, not a blocker)."
        )


if __name__ == "__main__":
    main()
