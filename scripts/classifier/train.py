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
    ap.add_argument("--c", type=float, default=8.0)
    ap.add_argument("--bags", type=int, default=1)
    ap.add_argument("--regex-scale", type=float, default=0.25)
    ap.add_argument("--class-weight", choices=["balanced", "sqrt", "none"], default="sqrt")
    args = ap.parse_args()

    from model2vec import StaticModel
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split

    rows = [json.loads(line) for line in args.corpus.open()]
    texts = [r["text"] for r in rows]
    labels = np.array([r["label"] for r in rows])

    model = StaticModel.from_pretrained(BACKBONE)
    t0 = time.time()
    E = l2(model.encode(texts, show_progress_bar=False))
    print(f"encoded {len(texts)} rows in {time.time() - t0:.1f}s")

    # Regex-as-feature: the heuristic's vote (annotate_regex.py) rides as a one-hot
    # block next to the embedding — the head LEARNS when to trust regex vocabulary
    # signals (file extensions, TL;DR, fix-verbs) instead of hard-coding precedence.
    from common import TASK_TYPES

    use_regex = all("regex" in r for r in rows)
    if use_regex:
        onehot = np.zeros((len(rows), len(TASK_TYPES)), dtype=np.float32)
        for i, r in enumerate(rows):
            onehot[i, TASK_TYPES.index(r["regex"])] = 1.0
        # Feature dropout: zero the vote on half the TRAINING rows so the head cannot
        # lean on regex as its primary signal — without it the head followed regex into
        # the conversational other-sink (measured: macro-F1 0.785 -> 0.727). Inference
        # always supplies the full vote; the head learns it as a tiebreaker.
        onehot *= args.regex_scale
        rng_drop = np.random.default_rng(args.seed + 1)
        train_onehot = onehot.copy()
        train_onehot[rng_drop.random(len(rows)) < 0.5] = 0.0
        X = np.hstack([E, train_onehot])
        X_serve = np.hstack([E, onehot])
        print(
            f"regex feature ON (+{len(TASK_TYPES)} dims, scale {args.regex_scale}, 0.5 dropout)"
        )
    else:
        X = E
        X_serve = E
        print("regex feature OFF (corpus not annotated — run annotate_regex.py)")

    idx = np.arange(len(rows))
    tr, rest = train_test_split(idx, test_size=0.30, random_state=args.seed, stratify=labels)
    cal, te = train_test_split(rest, test_size=0.50, random_state=args.seed, stratify=labels[rest])

    def fit_head(train_idx, weight):
        h = LogisticRegression(max_iter=3000, C=args.c, class_weight=weight)
        h.fit(X[train_idx], labels[train_idx])
        return h

    if args.class_weight == "sqrt":
        # sqrt-balanced: tempered upweighting so a tiny class (rag: 74 rows) gets help
        # without becoming a magnet — full "balanced" gave rag ~5x weight and it started
        # absorbing long technical prose (the LRU-design pin, measured 2026-07-23).
        counts = {c: int((labels == c).sum()) for c in set(labels)}
        n_max = max(counts.values())
        weight = {c: (n_max / n) ** 0.5 for c, n in counts.items()}
    else:
        weight = None if args.class_weight == "none" else "balanced"
    # Bagged head: average K logistic fits over resampled train splits — marginal rows
    # stopped flipping between corpus iterations once split sensitivity was averaged out.
    clf = fit_head(tr, weight)
    classes = clf.classes_
    if args.bags > 1:
        rng_bag = np.random.default_rng(args.seed)
        coefs, intercepts = [clf.coef_], [clf.intercept_]
        for _ in range(args.bags - 1):
            boot = rng_bag.choice(tr, size=len(tr), replace=True)
            h = fit_head(boot, weight)
            assert list(h.classes_) == list(classes)
            coefs.append(h.coef_)
            intercepts.append(h.intercept_)
        clf.coef_ = np.mean(coefs, axis=0)
        clf.intercept_ = np.mean(intercepts, axis=0)
    anchors = l2(np.stack([E[tr][labels[tr] == c].mean(axis=0) for c in classes]))

    # Conformal thresholds fit on the SEED-register slice of the calibration split:
    # serving traffic reads like curated seeds (real-user phrasing), not like MMLU
    # multiple choice — calibrating on the benchmark register measured 13-28pp
    # false-abstain on register-shifted eval rows. Falls back to the full split when
    # the seed slice is too thin for a stable 95th percentile.
    seed_cal = [i for i in cal if rows[i]["source"] == "seed"]
    cal_idx = seed_cal if len(seed_cal) >= 50 else list(cal)
    P_cal = clf.predict_proba(X_serve[cal_idx])
    srt = np.sort(P_cal, axis=1)
    margins = (srt[:, -1] - srt[:, -2]).tolist()
    dists = (1.0 - (E[cal_idx] @ anchors.T).max(axis=1)).tolist()
    tau_dist, tau_margin = fit_joint_abstain_thresholds(dists, margins, ALPHA)
    print(f"conformal cal rows: {len(cal_idx)} ({'seed-register' if cal_idx is seed_cal else 'full'})")
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
        regex_classes=np.array(list(TASK_TYPES) if use_regex else []),
        regex_scale=np.float32(args.regex_scale if use_regex else 0.0),
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
    full_pred = classes[clf.predict_proba(X_serve[te]).argmax(axis=1)]
    for j, (text, want) in enumerate(zip([texts[i] for i in te], full_pred, strict=True)):
        ids = tok.encode(text, add_special_tokens=False).ids
        v = deq[ids].mean(axis=0) if ids else np.zeros(deq.shape[1], dtype=np.float32)
        v = v / max(float(np.linalg.norm(v)), 1e-9)
        if use_regex:
            v = np.concatenate([v, onehot[te[j]]])
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
