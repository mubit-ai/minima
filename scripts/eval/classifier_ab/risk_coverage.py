"""Risk-coverage sweep over the conformal thresholds (PREREG §6).

The shipped point is (tau_dist, tau_margin) from head.npz. This asks whether a different
point on the abstention frontier would serve better — the question a keep/kill framing
misses, and the likeliest actionable outcome.

Two views, both reported:
  selective — accuracy on the rows the head chose to answer (the classic risk-coverage view)
  system    — accuracy of the FULL pipeline: vocabulary tier, then head where it commits,
              then regex on abstain. This is what production actually does, so it is the
              one a retune decision should be made on.

    uv run python scripts/eval/classifier_ab/risk_coverage.py \
        --eval-set <clean.jsonl> --artifact <dir> --out <rc.json>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-set", type=Path, required=True)
    ap.add_argument("--artifact", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    from minima.recommender.classify import high_precision_type, infer_task_type
    from minima.recommender.classify_embed import load_embed_classifier
    from minima.schemas.common import TaskType

    rows = [json.loads(ln) for ln in args.eval_set.open() if json.loads(ln)["label"]]
    head = load_embed_classifier(str(args.artifact), required=True)
    assert head is not None

    classes = [t.value for t in TaskType]
    cidx = {c: i for i, c in enumerate(classes)}
    k = len(classes)

    # Recompute the head's internals per row so the thresholds can be swept without
    # re-embedding: same arithmetic as EmbedClassifier.classify.
    np_ = head._np
    dists, margins, tops, vocab, regex, gold = [], [], [], [], [], []
    for r in rows:
        text = r["text"][:4096]
        ids = head._tokenizer.encode(text, add_special_tokens=False).ids
        if not ids:
            dists.append(1e9); margins.append(0.0); tops.append(cidx["other"])
        else:
            v = head._embeddings[ids].mean(axis=0)
            n = float(np_.linalg.norm(v))
            if n <= 0:
                dists.append(1e9); margins.append(0.0); tops.append(cidx["other"])
            else:
                v = v / n
                logits = head._coef @ v + head._intercept
                p = np_.exp(logits - logits.max()); p /= p.sum()
                order = np_.argsort(p)
                tops.append(cidx[head._classes[int(order[-1])].value])
                margins.append(float(p[order[-1]] - p[order[-2]]))
                dists.append(1.0 - float((head._anchors @ v).max()))
        hp = high_precision_type(r["text"])
        vocab.append(cidx[hp.value] if hp is not None else -1)
        regex.append(cidx[infer_task_type(r["text"]).value])
        gold.append(cidx[r["label"]])

    dists = np.array(dists); margins = np.array(margins)
    tops = np.array(tops); vocab = np.array(vocab)
    regex = np.array(regex); gold = np.array(gold)
    present = np.unique(gold)

    def macro_f1(pred):
        conf = np.bincount(gold * k + pred, minlength=k * k).reshape(k, k)
        tp = np.diag(conf).astype(float)
        fp = conf.sum(0) - tp
        fn = conf.sum(1) - tp
        d = 2 * tp + fp + fn
        f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
        return float(f1[present].mean())

    def evaluate(td, tm):
        abstain = (dists > td) | (margins < tm)
        covered = ~abstain
        sel_acc = float((tops[covered] == gold[covered]).mean()) if covered.any() else float("nan")
        system = np.where(vocab >= 0, vocab, np.where(abstain, regex, tops))
        return {
            "tau_dist": float(td),
            "tau_margin": float(tm),
            "coverage": float(covered.mean()),
            "selective_accuracy": sel_acc,
            "system_accuracy": float((system == gold).mean()),
            "system_macro_f1": macro_f1(system),
        }

    # Split by TASK, not by row: every row from one SNI task shares an identical
    # `Definition`, so a row-level split would put near-identical prompts on both sides
    # and the selected threshold would be validated on what it was fitted to.
    tasks = sorted({r["task"] for r in rows})
    rng = np.random.default_rng(20260727)
    perm = rng.permutation(len(tasks))
    val_tasks = {tasks[i] for i in perm[: len(tasks) // 2]}
    is_val = np.array([r["task"] in val_tasks for r in rows])

    def evaluate_on(mask, td, tm):
        ab = (dists > td) | (margins < tm)
        cov = (~ab) & mask
        system = np.where(vocab >= 0, vocab, np.where(ab, regex, tops))
        conf = np.bincount(gold[mask] * k + system[mask], minlength=k * k).reshape(k, k)
        tp = np.diag(conf).astype(float)
        fp = conf.sum(0) - tp
        fn = conf.sum(1) - tp
        d = 2 * tp + fp + fn
        f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
        pres = np.unique(gold[mask])
        return {
            "tau_dist": float(td),
            "tau_margin": float(tm),
            "coverage": float(cov.sum() / mask.sum()),
            "selective_accuracy": float((tops[cov] == gold[cov]).mean()) if cov.any() else float("nan"),
            "system_accuracy": float((system[mask] == gold[mask]).mean()),
            "system_macro_f1": float(f1[pres].mean()),
        }

    shipped = evaluate(head._tau_dist, head._tau_margin)
    regex_pred = np.where(vocab >= 0, vocab, regex)
    regex_only = {
        "system_accuracy": float((regex_pred == gold).mean()),
        "system_macro_f1": macro_f1(regex_pred),
    }

    grid = []
    for td in np.quantile(dists, np.linspace(0.02, 1.0, 25)):
        for tm in np.quantile(margins, np.linspace(0.0, 0.98, 25)):
            grid.append(evaluate(td, tm))

    # V3-style honest selection: pick tau on validation, report it on the held-out half.
    val_grid = [evaluate_on(is_val, g["tau_dist"], g["tau_margin"]) for g in grid]
    pick = max(val_grid, key=lambda g: g["system_macro_f1"])
    held_out = evaluate_on(~is_val, pick["tau_dist"], pick["tau_margin"])
    shipped_test = evaluate_on(~is_val, head._tau_dist, head._tau_margin)
    regex_test_pred = regex_pred[~is_val]
    conf = np.bincount(
        gold[~is_val] * k + regex_test_pred, minlength=k * k
    ).reshape(k, k)
    tp = np.diag(conf).astype(float)
    fp = conf.sum(0) - tp
    fn = conf.sum(1) - tp
    d = 2 * tp + fp + fn
    f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
    regex_test = {
        "system_accuracy": float((regex_test_pred == gold[~is_val]).mean()),
        "system_macro_f1": float(f1[np.unique(gold[~is_val])].mean()),
    }

    best_f1 = max(grid, key=lambda g: g["system_macro_f1"])
    args.out.write_text(
        json.dumps(
            {
                "n": len(rows),
                "n_tasks": len(tasks),
                "shipped_full": shipped,
                "regex_only_full": regex_only,
                "best_in_sample_full": best_f1,
                "validation_selected": pick,
                "held_out_at_selected_tau": held_out,
                "held_out_shipped_tau": shipped_test,
                "held_out_regex_only": regex_test,
                "grid": grid,
            },
            indent=1,
        )
    )
    print(f"n={len(rows)} over {len(tasks)} tasks (split by task, 50/50)")
    print(f"[full]     shipped   cov={shipped['coverage']:.3f} sel_acc={shipped['selective_accuracy']:.3f} "
          f"sys_acc={shipped['system_accuracy']:.3f} macroF1={shipped['system_macro_f1']:.3f}")
    print(f"[full]     regex-only                              "
          f"sys_acc={regex_only['system_accuracy']:.3f} macroF1={regex_only['system_macro_f1']:.3f}")
    print(f"[full]     best-in-sample (OPTIMISTIC) cov={best_f1['coverage']:.3f} "
          f"sel_acc={best_f1['selective_accuracy']:.3f} macroF1={best_f1['system_macro_f1']:.3f}")
    print()
    print(f"[val-pick] tau_dist={pick['tau_dist']:.4f} tau_margin={pick['tau_margin']:.4f} "
          f"(val macroF1={pick['system_macro_f1']:.3f})")
    print(f"[HELD-OUT] retuned  cov={held_out['coverage']:.3f} sel_acc={held_out['selective_accuracy']:.3f} "
          f"sys_acc={held_out['system_accuracy']:.3f} macroF1={held_out['system_macro_f1']:.3f}")
    print(f"[HELD-OUT] shipped  cov={shipped_test['coverage']:.3f} "
          f"sys_acc={shipped_test['system_accuracy']:.3f} macroF1={shipped_test['system_macro_f1']:.3f}")
    print(f"[HELD-OUT] regex                     "
          f"sys_acc={regex_test['system_accuracy']:.3f} macroF1={regex_test['system_macro_f1']:.3f}")


if __name__ == "__main__":
    main()
