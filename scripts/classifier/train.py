# /// script
# requires-python = ">=3.11"
# dependencies = ["model2vec>=0.5", "scikit-learn>=1.4", "numpy>=1.26"]
# ///
"""Train the task-type head on potion embeddings and export the versioned artifact.

Artifact bundle (all files hashed into classifier_id — see common.derive_classifier_id):
  embeddings.npz   int8 token-embedding table + per-row float32 scales
  head.npz         logistic coef/intercept, class order, centroid anchors, thresholds
  tokenizer.json   the backbone's tokenizer
  manifest.json    classifier_id + provenance (written LAST, excluded from the hash)

Inference needs numpy + tokenizers only (the [classifier] extra, PR-5) — this script's
torch-free training deps never enter the wheel. Run with `uv run`.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from common import fit_joint_abstain_thresholds, write_manifest

BACKBONE = "minishlab/potion-base-32M"
ALPHA = 0.05


def l2(x: np.ndarray) -> np.ndarray:
    return x / np.clip(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9, None)


def quantize_int8(emb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scales = np.abs(emb).max(axis=1, keepdims=True).astype(np.float32) / 127.0
    scales = np.clip(scales, 1e-12, None)
    q = np.clip(np.round(emb / scales), -127, 127).astype(np.int8)
    return q, scales.squeeze(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=Path("corpus.jsonl"))
    ap.add_argument("--out", type=Path, default=Path("artifact"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--report", type=Path, default=Path("train_report.json"))
    args = ap.parse_args()

    from model2vec import StaticModel
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split

    rows = [json.loads(line) for line in args.corpus.open()]
    texts = [r["text"] for r in rows]
    labels = np.array([r["label"] for r in rows])

    model = StaticModel.from_pretrained(BACKBONE)
    t0 = time.time()
    X = l2(model.encode(texts, show_progress_bar=False))
    print(f"encoded {len(texts)} rows in {time.time() - t0:.1f}s")

    idx = np.arange(len(rows))
    tr, rest = train_test_split(idx, test_size=0.30, random_state=args.seed, stratify=labels)
    cal, te = train_test_split(rest, test_size=0.50, random_state=args.seed, stratify=labels[rest])

    clf = LogisticRegression(max_iter=3000, C=8.0, class_weight="balanced")
    clf.fit(X[tr], labels[tr])
    classes = clf.classes_
    anchors = l2(np.stack([X[tr][labels[tr] == c].mean(axis=0) for c in classes]))

    P_cal = clf.predict_proba(X[cal])
    srt = np.sort(P_cal, axis=1)
    margins = (srt[:, -1] - srt[:, -2]).tolist()
    dists = (1.0 - (X[cal] @ anchors.T).max(axis=1)).tolist()
    tau_dist, tau_margin = fit_joint_abstain_thresholds(dists, margins, ALPHA)
    print(f"joint conformal thresholds: dist<= {tau_dist:.4f}, margin>= {tau_margin:.4f}")

    args.out.mkdir(parents=True, exist_ok=True)
    q, scales = quantize_int8(model.embedding.astype(np.float32))
    np.savez_compressed(args.out / "embeddings.npz", q=q, scales=scales)
    np.savez_compressed(
        args.out / "head.npz",
        coef=clf.coef_.astype(np.float32),
        intercept=clf.intercept_.astype(np.float32),
        anchors=anchors.astype(np.float32),
        classes=np.array([str(c) for c in classes]),
        tau_dist=np.float32(tau_dist),
        tau_margin=np.float32(tau_margin),
    )
    model.tokenizer.save(str(args.out / "tokenizer.json"))
    manifest = write_manifest(
        args.out,
        backbone=BACKBONE,
        dim=int(model.embedding.shape[1]),
        vocab=int(model.embedding.shape[0]),
        corpus_rows=len(rows),
        alpha=ALPHA,
    )
    print("classifier_id:", manifest["classifier_id"])

    # Quantization sanity: the int8 path must agree with the float path on held-out rows.
    deq = q.astype(np.float32) * scales[:, None]
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(args.out / "tokenizer.json"))
    agree = 0
    full_pred = classes[clf.predict_proba(X[te]).argmax(axis=1)]
    for text, want in zip([texts[i] for i in te], full_pred, strict=True):
        ids = tok.encode(text, add_special_tokens=False).ids
        v = deq[ids].mean(axis=0) if ids else np.zeros(deq.shape[1], dtype=np.float32)
        v = v / max(float(np.linalg.norm(v)), 1e-9)
        got = classes[int((clf.coef_ @ v + clf.intercept_).argmax())]
        agree += int(got == want)
    total_mb = sum(f.stat().st_size for f in args.out.iterdir()) / 1e6
    print(f"artifact {total_mb:.1f} MB | int8-vs-float agreement {agree}/{len(te)}")

    args.report.write_text(
        json.dumps(
            {
                "classifier_id": manifest["classifier_id"],
                "artifact_mb": round(total_mb, 1),
                "int8_agreement": f"{agree}/{len(te)}",
                "splits": {"train": len(tr), "cal": len(cal), "test": len(te)},
                "test_indices": [int(i) for i in te],
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
