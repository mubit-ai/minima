"""Contamination guard (PREREG §3).

SNI is not one of the head's training sources, but "not by provenance" is an argument, not
a measurement. This drops any eval row that is a near-twin of a RouterBench or CLINC150
row using the same definition of twin the savings harness already defends
(tests/eval/harness.py: normalized fingerprint + token Jaccard >= 0.6).

    uv run python scripts/eval/classifier_ab/contamination.py \
        --eval-set <in.jsonl> --out <clean.jsonl> --report <report.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sni import comparable, jaccard, norm_fingerprint, toks  # noqa: E402

NEARDUP_JACCARD = 0.6
# Only rare tokens make a useful blocking key; without blocking this is 2810 x ~400k.
_MIN_BLOCK_TOKEN_DF = 2000


def corpus_texts(cache: Path) -> list[str]:
    """The head's two public training sources, exactly as build_corpus.py consumes them."""
    texts: list[str] = []

    from minima.seeding import routerbench as rb

    df = rb.load_routerbench_df("0shot")
    col = "prompt" if "prompt" in df.columns else df.columns[0]
    texts += [str(p) for p in df[col].tolist()]
    print(f"routerbench prompts: {len(texts)}", flush=True)

    from datasets import load_dataset

    clinc = load_dataset("clinc/clinc_oos", "plus")
    n0 = len(texts)
    for split in ("train", "validation", "test"):
        texts += [str(e["text"]) for e in clinc[split]]
    print(f"clinc rows: {len(texts) - n0}", flush=True)

    from scripts.classifier.seeds import SEEDS  # type: ignore

    n1 = len(texts)
    texts += [t for v in SEEDS.values() for t in v]
    print(f"curated seeds: {len(texts) - n1}", flush=True)
    return texts


def _by_reason(rows: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        out[r["_reason"]] = out.get(r["_reason"], 0) + 1
    return out


def _by_class(rows: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        k = r["label"] or "~unmappable"
        out[k] = out.get(k, 0) + 1
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    args = ap.parse_args()

    rows = [json.loads(ln) for ln in args.eval_set.open()]
    corpus = corpus_texts(Path("."))

    fps = {norm_fingerprint(t) for t in corpus if comparable(t)}
    corpus_toks = [toks(t) if comparable(t) else set() for t in corpus]

    # Inverted index on low-document-frequency tokens so each eval row only compares
    # against corpus rows sharing a rare token.
    df_count: dict[str, int] = {}
    for ts in corpus_toks:
        for t in ts:
            df_count[t] = df_count.get(t, 0) + 1
    inv: dict[str, list[int]] = {}
    for i, ts in enumerate(corpus_toks):
        for t in ts:
            if df_count.get(t, 0) <= _MIN_BLOCK_TOKEN_DF:
                inv.setdefault(t, []).append(i)

    kept, dropped = [], []
    for r in rows:
        # The classified text is definition+input; the *input* is the part that could
        # plausibly recur in another benchmark, so both are checked. Strings too short to
        # carry a signal are never matched — see sni._MIN_TOKENS.
        for field in ("text", "input"):
            probe = r[field]
            if not comparable(probe):
                continue
            if norm_fingerprint(probe) in fps:
                dropped.append({**r, "_reason": f"exact fingerprint ({field})"})
                break
            pt = toks(probe)
            cand: set[int] = set()
            for t in pt:
                if df_count.get(t, 0) <= _MIN_BLOCK_TOKEN_DF:
                    cand.update(inv.get(t, ()))
            hit = next((i for i in cand if jaccard(pt, corpus_toks[i]) >= NEARDUP_JACCARD), None)
            if hit is not None:
                dropped.append({**r, "_reason": f"jaccard>={NEARDUP_JACCARD} ({field})"})
                break
        else:
            kept.append(r)

    with args.out.open("w") as fh:
        for r in kept:
            fh.write(json.dumps(r, sort_keys=True) + "\n")
    args.report.write_text(
        json.dumps(
            {
                "eval_rows_in": len(rows),
                "corpus_rows": len(corpus),
                "dropped": len(dropped),
                "kept": len(kept),
                "dropped_by_reason": _by_reason(dropped),
                "dropped_by_class": _by_class(dropped),
                "examples": dropped[:10],
            },
            indent=1,
        )
    )
    print(f"\nin={len(rows)} corpus={len(corpus)} dropped={len(dropped)} kept={len(kept)}")


if __name__ == "__main__":
    main()
