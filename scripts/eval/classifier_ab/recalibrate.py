"""Refit the conformal thresholds on a MIXED-distribution calibration set (S1e).

The shipped tau was fit on the seed-register slice of the training corpus
(`scripts/classifier/train.py:130-137`) precisely because the authors had already measured
register shift ("calibrating on the benchmark register measured 13-28pp false-abstain on
register-shifted eval rows"). The A/B found the seed register doesn't transfer either: G1e
passes at 1.8% false-abstain in corpus while real out-of-corpus error is ~70%.

This asks the obvious follow-up — does refitting on a mixture fix it — and reports the answer
plus the structural limit found along the way:

  `fit_joint_abstain_thresholds` sweeps qd from 0.95 UPWARD, so tau_dist can only ever land at
  or above the 95th percentile of calibration distances. Since `abstained = dist > tau_dist`,
  a HIGHER tau_dist abstains LESS. The fitter therefore cannot express an operating point that
  abstains more than ~alpha of the calibration mass, at any grid point, by construction.

REPORT ONLY. Nothing here writes an artifact: `derive_classifier_id` hashes the artifact
directory, so any tau change mints a new classifier_id and cannot be swapped in silently.

    uv run python scripts/eval/classifier_ab/recalibrate.py --out <recal.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "scripts" / "classifier"))

ARTIFACT = _REPO / "models" / "classifier" / "potion-base-32M-c18e819c6c6d"
FROZEN = _REPO / "tests" / "eval" / "data" / "classifier_frozen_set.jsonl"
SNI = _REPO / "tests" / "eval" / "data" / "classifier_sni_set.jsonl"
SEED = 20260727
ALPHA = 0.05


def head_internals(head, texts):
    """dist / margin / top-class per row, same arithmetic as EmbedClassifier.classify, so the
    thresholds can be swept without re-embedding."""
    np_ = head._np
    dists, margins, tops = [], [], []
    for text in texts:
        ids = head._tokenizer.encode(text[:4096], add_special_tokens=False).ids
        v = head._embeddings[ids].mean(axis=0) if ids else None
        n = float(np_.linalg.norm(v)) if v is not None else 0.0
        if n <= 0:
            dists.append(1e9)
            margins.append(0.0)
            tops.append("other")
            continue
        v = v / n
        logits = head._coef @ v + head._intercept
        p = np_.exp(logits - logits.max())
        p /= p.sum()
        order = np_.argsort(p)
        tops.append(head._classes[int(order[-1])].value)
        margins.append(float(p[order[-1]] - p[order[-2]]))
        dists.append(1.0 - float((head._anchors @ v).max()))
    return np.array(dists), np.array(margins), np.array(tops, dtype=object)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    from common import fit_joint_abstain_thresholds

    from minima.recommender.classify import high_precision_type, infer_task_type
    from minima.recommender.classify_embed import load_embed_classifier

    head = load_embed_classifier(str(ARTIFACT), required=True)
    assert head is not None

    frozen = [json.loads(line) for line in FROZEN.open()]
    sni = [json.loads(line) for line in SNI.open()]

    # Split SNI by TASK, not by row (rows in one task share a Definition), with the same seed
    # and halving as risk_coverage.py so the two studies are talking about the same split.
    tasks = sorted({r["task"] for r in sni})
    perm = np.random.default_rng(SEED).permutation(len(tasks))
    val_tasks = {tasks[i] for i in perm[: len(tasks) // 2]}

    # Calibration mixture: out-of-corpus prose (SNI validation half) + true-OOS + the seed
    # register. `conversational` stands in for the seed register — it is the closest available
    # proxy and, critically, is NOT the slice G1e scores, so G1e stays an honest holdout.
    # It is only 30 rows; that thinness is a real limitation of this refit.
    cal = (
        [r for r in sni if r["task"] in val_tasks]
        + [r for r in frozen if r["slice"] == "oos"]
        + [r for r in frozen if r["slice"] == "conversational"]
    )
    typed = [r for r in frozen if r["slice"] == "typed"]
    test = [r for r in sni if r["task"] not in val_tasks]

    cal_d, cal_m, _ = head_internals(head, [r["text"] for r in cal])
    typed_d, typed_m, typed_top = head_internals(head, [r["text"] for r in typed])
    test_d, test_m, test_top = head_internals(head, [r["text"] for r in test])

    test_gold = np.array([r["label"] for r in test], dtype=object)
    test_vocab = np.array(
        [(hp.value if (hp := high_precision_type(r["text"])) else None) for r in test],
        dtype=object,
    )
    test_regex = np.array([infer_task_type(r["text"]).value for r in test], dtype=object)
    typed_gold = np.array([r["label"] for r in typed], dtype=object)

    present = sorted(set(test_gold))

    def system_macro_f1(td, tm):
        ab = (test_d > td) | (test_m < tm)
        pred = np.where(
            test_vocab != None,  # noqa: E711 — object array, `is not None` won't vectorize
            test_vocab,
            np.where(ab, test_regex, test_top),
        )
        scores = []
        for lab in present:
            tp = int(((test_gold == lab) & (pred == lab)).sum())
            fp = int(((test_gold != lab) & (pred == lab)).sum())
            fn = int(((test_gold == lab) & (pred != lab)).sum())
            d = 2 * tp + fp + fn
            scores.append(2 * tp / d if d else 0.0)
        return float(np.mean(scores)), float((pred == test_gold).mean()), float(1 - ab.mean())

    def g1e(td, tm):
        return float(((typed_d > td) | (typed_m < tm)).mean())

    def typed_err(td, tm):
        """Error rate among the typed rows the head still COMMITS on — the quantity G1e's
        false-abstain bound is silent about."""
        ok = ~((typed_d > td) | (typed_m < tm))
        return float((typed_top[ok] != typed_gold[ok]).mean()) if ok.any() else float("nan")

    shipped = (float(head._tau_dist), float(head._tau_margin))
    refit = fit_joint_abstain_thresholds(cal_d.tolist(), cal_m.tolist(), ALPHA)

    # What alpha would the shipped fitter need before its grid can even REACH the
    # risk-coverage optimum? The optimum sits at a low distance quantile; the fitter starts at
    # 0.95 and rises, so the answer is the tail mass it would have to be allowed to abstain.
    grid = []
    for q in np.linspace(0.02, 1.0, 50):
        td = float(np.quantile(cal_d, q))
        f1, acc, cov = system_macro_f1(td, 0.0)
        grid.append({"q": float(q), "tau_dist": td, "macro_f1": f1, "accuracy": acc,
                     "coverage": cov, "cal_abstain_rate": float((cal_d > td).mean())})
    best = max(grid, key=lambda g: g["macro_f1"])

    regex_only_pred = np.where(test_vocab != None, test_vocab, test_regex)  # noqa: E711
    regex_scores = []
    for lab in present:
        tp = int(((test_gold == lab) & (regex_only_pred == lab)).sum())
        fp = int(((test_gold != lab) & (regex_only_pred == lab)).sum())
        fn = int(((test_gold == lab) & (regex_only_pred != lab)).sum())
        d = 2 * tp + fp + fn
        regex_scores.append(2 * tp / d if d else 0.0)

    # The distance-only sweep above holds tau_margin at 0, which is not a fair test of the
    # frontier — the shipped abstention rule is a UNION of two thresholds. So: sweep the joint
    # grid, select the point on the CALIBRATION half, then score it once on held-out against
    # vocab+regex with a paired bootstrap. If that CI straddles zero, no reachable operating
    # point beats the stack the head replaces, and "retune tau" is not an available remedy.
    lab_idx = {lab: i for i, lab in enumerate(present)}
    kk = len(present)
    OTHER = kk  # any prediction outside the gold-present set lands in one absorbing column

    def codes(arr):
        return np.array([lab_idx.get(x, OTHER) for x in arr])

    gold_c = codes(test_gold)
    regex_c = codes(regex_only_pred)

    def macro_from(pred_c, gi, pi):
        conf = np.bincount(gi * (kk + 1) + pi, minlength=kk * (kk + 1) + (kk + 1))
        conf = conf.reshape(kk + 1, kk + 1)[:kk]
        tp = np.diag(conf[:, :kk]).astype(np.float64)
        fp = conf[:, :kk].sum(axis=0) - tp
        fn = conf.sum(axis=1) - tp
        d = 2 * tp + fp + fn
        return float(np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0).mean())

    joint = []
    for td in np.quantile(cal_d, np.linspace(0.02, 1.0, 25)):
        for tm in np.quantile(cal_m, np.linspace(0.0, 0.98, 25)):
            ab = (cal_d > td) | (cal_m < tm)
            joint.append({"tau_dist": float(td), "tau_margin": float(tm),
                          "cal_coverage": float(1 - ab.mean())})
    # Score each candidate on the calibration half (its own system macro-F1), pick the best.
    cal_gold = np.array([r["label"] for r in cal], dtype=object)
    cal_vocab = np.array(
        [(hp.value if (hp := high_precision_type(r["text"])) else None) for r in cal], dtype=object
    )
    cal_regex = np.array([infer_task_type(r["text"]).value for r in cal], dtype=object)
    _, _, cal_top = head_internals(head, [r["text"] for r in cal])
    cal_present = sorted(set(cal_gold))

    def cal_macro(td, tm):
        ab = (cal_d > td) | (cal_m < tm)
        pred = np.where(cal_vocab != None, cal_vocab, np.where(ab, cal_regex, cal_top))  # noqa: E711
        scores = []
        for lab in cal_present:
            tp = int(((cal_gold == lab) & (pred == lab)).sum())
            fp = int(((cal_gold != lab) & (pred == lab)).sum())
            fn = int(((cal_gold == lab) & (pred != lab)).sum())
            d = 2 * tp + fp + fn
            scores.append(2 * tp / d if d else 0.0)
        return float(np.mean(scores))

    for g in joint:
        g["cal_macro_f1"] = cal_macro(g["tau_dist"], g["tau_margin"])
    picked = max(joint, key=lambda g: g["cal_macro_f1"])

    ab_t = (test_d > picked["tau_dist"]) | (test_m < picked["tau_margin"])
    tuned_pred = np.where(test_vocab != None, test_vocab, np.where(ab_t, test_regex, test_top))  # noqa: E711
    tuned_c = codes(tuned_pred)
    rng = np.random.default_rng(SEED)
    m = len(gold_c)
    deltas = np.empty(10_000)
    for i in range(10_000):
        idx = rng.integers(0, m, m)
        deltas[i] = macro_from(None, gold_c[idx], tuned_c[idx]) - macro_from(
            None, gold_c[idx], regex_c[idx]
        )
    joint_result = {
        "selected_on_calibration": picked,
        "held_out_coverage": float(1 - ab_t.mean()),
        "held_out_tuned_macro_f1": macro_from(None, gold_c, tuned_c),
        "held_out_regex_macro_f1": macro_from(None, gold_c, regex_c),
        "delta_vs_regex": macro_from(None, gold_c, tuned_c) - macro_from(None, gold_c, regex_c),
        "ci95": [float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))],
        "p_gt_0": float((deltas > 0).mean()),
    }

    out = {
        "calibration": {
            "n": len(cal),
            "composition": {
                "sni_validation_half": sum(1 for r in sni if r["task"] in val_tasks),
                "frozen_oos": sum(1 for r in frozen if r["slice"] == "oos"),
                "frozen_conversational": sum(1 for r in frozen if r["slice"] == "conversational"),
            },
            "alpha": ALPHA,
        },
        "held_out": {"sni_test_half_n": len(test), "frozen_typed_n": len(typed)},
        "shipped": {
            "tau_dist": shipped[0], "tau_margin": shipped[1],
            "g1e_false_abstain": g1e(*shipped),
            "typed_error_when_committed": typed_err(*shipped),
            "held_out_system_macro_f1": system_macro_f1(*shipped)[0],
            "held_out_system_accuracy": system_macro_f1(*shipped)[1],
            "held_out_coverage": system_macro_f1(*shipped)[2],
        },
        "refit_mixed_alpha_005": {
            "tau_dist": refit[0], "tau_margin": refit[1],
            "g1e_false_abstain": g1e(*refit),
            "typed_error_when_committed": typed_err(*refit),
            "held_out_system_macro_f1": system_macro_f1(*refit)[0],
            "held_out_system_accuracy": system_macro_f1(*refit)[1],
            "held_out_coverage": system_macro_f1(*refit)[2],
        },
        "regex_only_held_out": {"system_macro_f1": float(np.mean(regex_scores))},
        "fitter_reachable_range": {
            "min_tau_dist_at_alpha_005": float(np.quantile(cal_d, 0.95)),
            "max_tau_dist": float(cal_d.max()),
            "note": "grid starts at qd=0.95 and rises; tau_dist below q95 is unreachable",
        },
        "unconstrained_optimum": best,
        "alpha_required_for_optimum": 1.0 - best["q"],
        "joint_sweep_vs_regex": joint_result,
        "grid": grid,
    }
    args.out.write_text(json.dumps(out, indent=1))

    s, r = out["shipped"], out["refit_mixed_alpha_005"]
    print(f"calibration n={len(cal)} ({out['calibration']['composition']})")
    print(f"held-out: SNI test half n={len(test)}, frozen typed n={len(typed)}\n")
    print(f"{'':26} {'tau_dist':>9} {'tau_margin':>11} {'G1e':>7} {'cover':>7} {'macroF1':>8}")
    print(f"{'shipped':26} {s['tau_dist']:>9.4f} {s['tau_margin']:>11.6f} "
          f"{s['g1e_false_abstain']:>7.3f} {s['held_out_coverage']:>7.3f} "
          f"{s['held_out_system_macro_f1']:>8.4f}")
    print(f"{'refit on mixture a=0.05':26} {r['tau_dist']:>9.4f} {r['tau_margin']:>11.6f} "
          f"{r['g1e_false_abstain']:>7.3f} {r['held_out_coverage']:>7.3f} "
          f"{r['held_out_system_macro_f1']:>8.4f}")
    print(f"{'regex only (vocab+regex)':26} {'—':>9} {'—':>11} {'—':>7} {0.0:>7.3f} "
          f"{out['regex_only_held_out']['system_macro_f1']:>8.4f}")
    print(f"\ntyped error WHEN COMMITTED: shipped {s['typed_error_when_committed']:.3f} "
          f"| refit {r['typed_error_when_committed']:.3f}")
    print(f"\nunconstrained optimum: tau_dist={best['tau_dist']:.4f} at cal-quantile "
          f"{best['q']:.2f} -> macroF1 {best['macro_f1']:.4f}, coverage {best['coverage']:.3f}")
    print(f"fitter can only reach tau_dist >= {out['fitter_reachable_range']['min_tau_dist_at_alpha_005']:.4f} "
          f"(q95). Optimum needs alpha >= {out['alpha_required_for_optimum']:.2f}.")
    j = joint_result
    print("\nJOINT sweep, selected on calibration -> scored once on held-out:")
    print(f"  tau=({j['selected_on_calibration']['tau_dist']:.4f}, "
          f"{j['selected_on_calibration']['tau_margin']:.6f})  coverage {j['held_out_coverage']:.3f}")
    print(f"  tuned {j['held_out_tuned_macro_f1']:.4f}  vs  vocab+regex "
          f"{j['held_out_regex_macro_f1']:.4f}")
    print(f"  delta {j['delta_vs_regex']:+.4f}  95% CI [{j['ci95'][0]:+.4f}, {j['ci95'][1]:+.4f}]  "
          f"P(delta>0)={j['p_gt_0']:.3f}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
