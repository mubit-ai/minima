# /// script
# requires-python = ">=3.11"
# dependencies = ["datasets>=2.19", "pandas>=2.0", "huggingface-hub>=0.23"]
# ///
"""Assemble the classifier training corpus -> corpus.jsonl {text, label, source}.

Privacy-clean by construction: curated seeds (seeds.py) + public datasets (CLINC150,
RouterBench) only — tenant decision-log content NEVER enters the shipped global artifact
(no consent field exists in the tenancy schema). Run with `uv run`.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path

from common import (
    CLINC_CAP_PER_TYPE,
    CLINC_MAP,
    CLINC_TYPE_CAPS,
    RB_CAP_PER_TYPE,
    RB_EVAL_MAP,
    RB_TYPE_CAPS,
    dedupe,
    norm,
)
from seeds import SEEDS


def collect_seeds() -> list[dict]:
    return [
        {"text": norm(t), "label": label, "source": "seed"}
        for label, texts in SEEDS.items()
        for t in texts
    ]


def collect_clinc(rng: random.Random) -> tuple[list[dict], list[str]]:
    from datasets import load_dataset

    clinc = load_dataset("clinc/clinc_oos", "plus")
    names = clinc["train"].features["intent"].names
    rows: list[dict] = []
    per_type: dict[str, int] = {}
    examples = list(clinc["train"]) + list(clinc["validation"])
    rng.shuffle(examples)
    for e in examples:
        intent = names[e["intent"]]
        label = CLINC_MAP.get(intent)
        if label is None or per_type.get(label, 0) >= CLINC_TYPE_CAPS.get(label, CLINC_CAP_PER_TYPE):
            continue
        per_type[label] = per_type.get(label, 0) + 1
        rows.append({"text": norm(e["text"]), "label": label, "source": f"clinc:{intent}"})
    oos_holdout = [norm(e["text"]) for e in clinc["test"] if names[e["intent"]] == "oos"]
    print("clinc mapped:", per_type, "| oos diagnostic holdout:", len(oos_holdout))
    return rows, oos_holdout


def collect_routerbench() -> list[dict]:
    import pandas as pd
    from huggingface_hub import hf_hub_download

    pkl = hf_hub_download("withmartian/routerbench", "routerbench_0shot.pkl", repo_type="dataset")
    df = pd.read_pickle(pkl).sample(frac=1.0, random_state=7)
    rows: list[dict] = []
    counts: dict[str, int] = {}
    for _, r in df.iterrows():
        ev = str(r["eval_name"]).lower()
        label = next((lab for key, lab in RB_EVAL_MAP if key in ev), None)
        if label is None or counts.get(label, 0) >= RB_TYPE_CAPS.get(label, RB_CAP_PER_TYPE):
            continue
        text = r["prompt"]
        if isinstance(text, list):
            text = " ".join(str(x) for x in text)
        text = norm(str(text))[:2000]
        if len(text) < 12:
            continue
        counts[label] = counts.get(label, 0) + 1
        rows.append({"text": text, "label": label, "source": f"routerbench:{ev}"})
    print("routerbench:", counts)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("corpus.jsonl"))
    ap.add_argument("--oos-out", type=Path, default=Path("clinc_oos_diagnostic.json"))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    rows = collect_seeds()
    clinc_rows, oos_holdout = collect_clinc(rng)
    rows += clinc_rows
    rows += collect_routerbench()
    out = dedupe(rows)
    rng.shuffle(out)

    with args.out.open("w") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    args.oos_out.write_text(json.dumps(oos_holdout))
    print("TOTAL", len(out), Counter(r["label"] for r in out))


if __name__ == "__main__":
    main()
