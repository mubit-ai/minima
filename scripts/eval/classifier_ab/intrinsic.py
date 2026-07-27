"""Leg A — the intrinsic arm comparison (PREREG §2, §4, §5).

Runs every arm over the frozen SNI set, checks the sanity gates, and computes the
pre-registered primary endpoint with a paired bootstrap CI plus the declared secondaries.

    uv run python scripts/eval/classifier_ab/intrinsic.py \
        --eval-set <clean.jsonl> --artifact <dir> --out <results.json>
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from arms import build_arms  # noqa: E402
from category_map import CONTESTABLE  # noqa: E402

BOOTSTRAP = 10_000
SEED = 20260727


def _macro_f1_from_conf(conf: np.ndarray, gold_classes: np.ndarray) -> float:
    tp = np.diag(conf).astype(np.float64)
    fp = conf.sum(axis=0) - tp
    fn = conf.sum(axis=1) - tp
    denom = 2 * tp + fp + fn
    f1 = np.divide(2 * tp, denom, out=np.zeros_like(denom), where=denom > 0)
    return float(f1[gold_classes].mean())


def _conf(gold: np.ndarray, pred: np.ndarray, k: int) -> np.ndarray:
    return np.bincount(gold * k + pred, minlength=k * k).reshape(k, k)


def _paired_bootstrap(gold, pa, pb, k, gold_classes, n=BOOTSTRAP, seed=SEED):
    """Resample PROMPTS (not predictions) so the two arms stay paired on every draw."""
    rng = np.random.default_rng(seed)
    m = len(gold)
    ca, cb = gold * k + pa, gold * k + pb
    deltas = np.empty(n, dtype=np.float64)
    for i in range(n):
        idx = rng.integers(0, m, m)
        fa = _macro_f1_from_conf(np.bincount(ca[idx], minlength=k * k).reshape(k, k), gold_classes)
        fb = _macro_f1_from_conf(np.bincount(cb[idx], minlength=k * k).reshape(k, k), gold_classes)
        deltas[i] = fa - fb
    return deltas


def _mcnemar(gold: np.ndarray, pa: np.ndarray, pb: np.ndarray) -> dict:
    a_ok, b_ok = pa == gold, pb == gold
    b = int((a_ok & ~b_ok).sum())  # A right, B wrong
    c = int((~a_ok & b_ok).sum())  # A wrong, B right
    n = b + c
    if n == 0:
        return {"b": b, "c": c, "p_value": 1.0}
    # exact two-sided binomial
    tail = sum(math.comb(n, i) for i in range(0, min(b, c) + 1)) * 0.5**n
    return {"b": b, "c": c, "p_value": float(min(1.0, 2 * tail))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--artifact", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    rows = [json.loads(ln) for ln in args.eval_set.open()]
    mapped = [r for r in rows if r["label"]]
    unmapped = [r for r in rows if not r["label"]]
    print(f"rows: {len(rows)} (mapped {len(mapped)}, unmappable {len(unmapped)})")

    arms = build_arms(args.artifact)

    # --- run every arm over every row -------------------------------------------------
    preds: dict[str, list] = {}
    latency: dict[str, dict] = {}
    for key, arm in arms.items():
        t0 = time.perf_counter()
        out = [arm.predict(r["text"], gold=r["label"]) for r in rows]
        elapsed = time.perf_counter() - t0
        per = []
        for r in rows[:600]:
            t1 = time.perf_counter()
            arm.predict(r["text"], gold=r["label"])
            per.append((time.perf_counter() - t1) * 1000)
        preds[key] = out
        latency[key] = {
            "mean_ms": elapsed / len(rows) * 1000,
            "p50_ms": float(np.percentile(per, 50)),
            "p99_ms": float(np.percentile(per, 99)),
        }
        print(f"  {key:4s} done  ({latency[key]['p50_ms']:.3f} ms p50)")

    # --- sanity gates (PREREG §4) -----------------------------------------------------
    from minima.recommender.classify import high_precision_type, infer_task_type

    gates = {}
    gates["S2_A1_is_regex"] = all(
        p.task_type == infer_task_type(r["text"]).value for p, r in zip(preds["A1"], rows, strict=True)
    )
    gates["S3_A2_no_embedding_source"] = not any(p.source == "embedding" for p in preds["A2"])
    gates["S3_A2_matches_A1_off_vocab"] = all(
        a1.task_type == a2.task_type
        for a1, a2, r in zip(preds["A1"], preds["A2"], rows, strict=True)
        if high_precision_type(r["text"]) is None
    )
    gates["S4_A3a_equals_A3b"] = all(
        a.task_type == b.task_type and a.abstained == b.abstained
        for a, b in zip(preds["A3a"], preds["A3b"], strict=True)
    )
    gates["S1_A5_is_oracle"] = all(
        p.task_type == r["label"] for p, r in zip(preds["A5"], rows, strict=True) if r["label"]
    )
    print("\nsanity gates:")
    for g, ok in gates.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {g}")

    # --- scoring ----------------------------------------------------------------------
    from minima.schemas.common import TaskType

    classes = [t.value for t in TaskType]
    cidx = {c: i for i, c in enumerate(classes)}
    k = len(classes)

    def score_slice(sub_rows, sub_idx) -> dict:
        gold = np.array([cidx[r["label"]] for r in sub_rows])
        gold_classes = np.unique(gold)
        res = {"n": len(sub_rows), "gold_classes": [classes[i] for i in gold_classes]}
        per_arm = {}
        for key in arms:
            pred = np.array([cidx[preds[key][i].task_type] for i in sub_idx])
            conf = _conf(gold, pred, k)
            tp = np.diag(conf).astype(float)
            fp = conf.sum(axis=0) - tp
            fn = conf.sum(axis=1) - tp
            denom = 2 * tp + fp + fn
            f1 = np.divide(2 * tp, denom, out=np.zeros_like(denom), where=denom > 0)
            prec = np.divide(tp, tp + fp, out=np.zeros_like(tp), where=(tp + fp) > 0)
            rec = np.divide(tp, tp + fn, out=np.zeros_like(tp), where=(tp + fn) > 0)
            abst = [preds[key][i].abstained for i in sub_idx]
            per_arm[key] = {
                "macro_f1": _macro_f1_from_conf(conf, gold_classes),
                "accuracy": float((pred == gold).mean()),
                "per_class": {
                    classes[c]: {
                        "precision": float(prec[c]),
                        "recall": float(rec[c]),
                        "f1": float(f1[c]),
                        "support": int(conf[c].sum()),
                    }
                    for c in gold_classes
                },
                "leak_to_other": float(
                    (pred == cidx["other"]).sum() / max(1, len(sub_rows))
                ),
                "pred_into_absent_classes": float(
                    sum(1 for p in pred if p not in gold_classes) / max(1, len(sub_rows))
                ),
                "abstain_rate": float(
                    sum(1 for a in abst if a) / max(1, sum(1 for a in abst if a is not None))
                )
                if any(a is not None for a in abst)
                else None,
                "source_mix": {
                    s: sum(1 for i in sub_idx if preds[key][i].source == s) / len(sub_idx)
                    for s in sorted({preds[key][i].source for i in sub_idx})
                },
            }
        res["arms"] = per_arm

        # primary endpoint + every adjacent pair
        pairs = [("A3b", "A2"), ("A3a", "A2"), ("A3a", "A3b"), ("A2", "A1"), ("A3b", "A1")]
        res["comparisons"] = {}
        for hi, lo in pairs:
            ph = np.array([cidx[preds[hi][i].task_type] for i in sub_idx])
            pl = np.array([cidx[preds[lo][i].task_type] for i in sub_idx])
            d = _paired_bootstrap(gold, ph, pl, k, gold_classes)
            res["comparisons"][f"{hi}-{lo}"] = {
                "delta_macro_f1": per_arm[hi]["macro_f1"] - per_arm[lo]["macro_f1"],
                "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
                "p_gt_0": float((d > 0).mean()),
                "mcnemar": _mcnemar(gold, ph, pl),
                "disagreement_rate": float((ph != pl).mean()),
            }
        return res

    idx_of = {id(r): i for i, r in enumerate(rows)}
    mapped_idx = [idx_of[id(r)] for r in mapped]
    primary = score_slice(mapped, mapped_idx)

    # sensitivity: drop the contestable categories (PREREG §5)
    sens_rows = [r for r in mapped if r["category"] not in CONTESTABLE]
    sens = score_slice(sens_rows, [idx_of[id(r)] for r in sens_rows])

    # unmappable slice: abstention behavior only (PREREG §3 R3)
    un_idx = [idx_of[id(r)] for r in unmapped]
    unmappable = {
        "n": len(unmapped),
        "arms": {
            key: {
                "abstain_rate": (
                    sum(1 for i in un_idx if preds[key][i].abstained) / len(un_idx)
                    if any(preds[key][i].abstained is not None for i in un_idx)
                    else None
                ),
                "to_other": sum(1 for i in un_idx if preds[key][i].task_type == "other")
                / len(un_idx),
            }
            for key in arms
        },
    }

    result = {
        "eval_set": str(args.eval_set),
        "artifact": str(args.artifact),
        "gates": gates,
        "latency": latency,
        "primary_slice": primary,
        "sensitivity_drop_contestable": sens,
        "unmappable_slice": unmappable,
    }
    args.out.write_text(json.dumps(result, indent=1))

    p = primary["comparisons"]["A3b-A2"]
    print(f"\nPRIMARY  A3b - A2 macro-F1 = {p['delta_macro_f1']:+.4f}  "
          f"CI95 [{p['ci95'][0]:+.4f}, {p['ci95'][1]:+.4f}]  McNemar p={p['mcnemar']['p_value']:.2e}")
    for key in arms:
        print(f"  {key:4s} macro-F1 {primary['arms'][key]['macro_f1']:.4f}  "
              f"acc {primary['arms'][key]['accuracy']:.4f}")


if __name__ == "__main__":
    main()
