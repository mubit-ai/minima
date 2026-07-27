"""A6 — "route, don't replace" (PREREG-A6.md, frozen at 0b3e422).

Primary: Δ = macro-F1(A6) − macro-F1(A2) on the HELD-OUT half of a task-level 50/50 split,
where A6's deny set was selected on the validation half. Paired bootstrap, 10k draws.

    uv run python scripts/eval/classifier_ab/a6.py --out reports/data/a6.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from arms import Arm, DenySetClassifier, StubAbstainClassifier  # noqa: E402

_REPO = Path(__file__).resolve().parents[3]
ARTIFACT = _REPO / "models" / "classifier" / "potion-base-32M-c18e819c6c6d"
SNI = _REPO / "tests" / "eval" / "data" / "classifier_sni_set.jsonl"
SEED = 20260727
BOOTSTRAP = 10_000

# A6' — the literal vocabulary-tier extension. Written to the tier's stated contract
# ("near-zero false positive"), so these demand an explicit imperative plus an object, not the
# mere presence of the word. Prepended to _HIGH_PRECISION for that arm only.
_A6_PRIME_PATTERNS = (
    (
        re.compile(
            r"\btranslat(?:e|es|ed|ing|ion)\b[^.?!]{0,60}?\b(?:into|to|from|in)\s+"
            r"(?:the\s+)?[A-Z]?[a-z]{3,}",
            re.IGNORECASE,
        ),
        "translation",
    ),
    (
        re.compile(
            r"\b(?:summariz|summaris)(?:e|es|ed|ing|ation)\b|\bwrite\s+a\s+summary\b"
            r"|\bin\s+one\s+sentence\b",
            re.IGNORECASE,
        ),
        "summarization",
    ),
)


def _macro(gold, pred, present, k):
    conf = np.bincount(gold * k + pred, minlength=k * k).reshape(k, k)
    tp = np.diag(conf).astype(np.float64)
    fp = conf.sum(axis=0) - tp
    fn = conf.sum(axis=1) - tp
    d = 2 * tp + fp + fn
    f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
    return float(f1[present].mean())


def _per_class_f1(gold, pred, present, k):
    conf = np.bincount(gold * k + pred, minlength=k * k).reshape(k, k)
    tp = np.diag(conf).astype(np.float64)
    fp = conf.sum(axis=0) - tp
    fn = conf.sum(axis=1) - tp
    d = 2 * tp + fp + fn
    f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
    return {int(c): float(f1[c]) for c in present}


def _paired_bootstrap(gold, pa, pb, present, k):
    rng = np.random.default_rng(SEED)
    m = len(gold)
    ca, cb = gold * k + pa, gold * k + pb
    out = np.empty(BOOTSTRAP)
    for i in range(BOOTSTRAP):
        idx = rng.integers(0, m, m)
        ca_i = np.bincount(ca[idx], minlength=k * k).reshape(k, k)
        cb_i = np.bincount(cb[idx], minlength=k * k).reshape(k, k)
        for conf, slot in ((ca_i, 0), (cb_i, 1)):
            tp = np.diag(conf).astype(np.float64)
            fp = conf.sum(axis=0) - tp
            fn = conf.sum(axis=1) - tp
            d = 2 * tp + fp + fn
            f1 = np.divide(2 * tp, d, out=np.zeros_like(d), where=d > 0)
            if slot == 0:
                a = float(f1[present].mean())
            else:
                b = float(f1[present].mean())
        out[i] = a - b
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    from minima.recommender.classify import high_precision_type, infer_task_type
    from minima.recommender.classify_embed import load_embed_classifier
    from minima.schemas.common import TaskType

    head = load_embed_classifier(str(ARTIFACT), required=True)
    assert head is not None

    rows = [json.loads(line) for line in SNI.open()]
    classes = [t.value for t in TaskType]
    cidx = {c: i for i, c in enumerate(classes)}
    k = len(classes)

    # Task-level split, byte-identical to risk_coverage.py:106-110.
    tasks = sorted({r["task"] for r in rows})
    perm = np.random.default_rng(SEED).permutation(len(tasks))
    val_tasks = {tasks[i] for i in perm[: len(tasks) // 2]}
    is_val = np.array([r["task"] in val_tasks for r in rows])

    texts = [r["text"] for r in rows]
    gold = np.array([cidx[r["label"]] for r in rows])

    a2 = Arm("A2", "vocabulary + regex", StubAbstainClassifier())
    a3b = Arm("A3b", "vocabulary + head", head)
    p_a2 = np.array([cidx[a2.predict(t).task_type] for t in texts])
    p_a3b = np.array([cidx[a3b.predict(t).task_type] for t in texts])

    # --- deny set, selected on the VALIDATION half only -------------------------------------
    val_present = np.unique(gold[is_val])
    f1_head_val = _per_class_f1(gold[is_val], p_a3b[is_val], val_present, k)
    f1_regex_val = _per_class_f1(gold[is_val], p_a2[is_val], val_present, k)
    deny = frozenset(
        classes[c] for c in val_present if f1_head_val[c] < f1_regex_val[c]
    )

    test_present = np.unique(gold[~is_val])
    f1_head_test = _per_class_f1(gold[~is_val], p_a3b[~is_val], test_present, k)
    f1_regex_test = _per_class_f1(gold[~is_val], p_a2[~is_val], test_present, k)
    deny_oracle = frozenset(
        classes[c] for c in test_present if f1_head_test[c] < f1_regex_test[c]
    )
    deny_fixed = frozenset({"translation", "summarization"})

    def run_deny(d):
        arm = Arm("A6", f"deny={sorted(d)}", DenySetClassifier(head, d))
        return np.array([cidx[arm.predict(t).task_type] for t in texts])

    p_a6 = run_deny(deny)
    p_a6_fixed = run_deny(deny_fixed)
    p_a6_oracle = run_deny(deny_oracle)

    # --- A6': vocabulary-pattern variant ----------------------------------------------------
    # Two forms, because they answer different questions and only one is the literal proposal:
    #   A6'a  patterns -> HEAD -> regex on abstain   ("head decides the rest")
    #   A6'b  patterns -> vocabulary -> regex        (the head deleted entirely)
    # A6'b is the control that tells us whether any A6' gain is the patterns or the head.
    def _prime_hit(text):
        for pattern, tt in _A6_PRIME_PATTERNS:
            if pattern.search(text):
                return tt
        return None

    def a6_prime_a(text):
        hit = _prime_hit(text)
        return hit if hit is not None else a3b.predict(text).task_type

    def a6_prime_b(text):
        hit = _prime_hit(text)
        if hit is not None:
            return hit
        hp = high_precision_type(text)
        return hp.value if hp is not None else infer_task_type(text).value

    prime_fires = np.array([_prime_hit(t) is not None for t in texts])
    p_a6_prime_a = np.array([cidx[a6_prime_a(t)] for t in texts])
    p_a6_prime_b = np.array([cidx[a6_prime_b(t)] for t in texts])
    prime_pred = np.array(
        [next((tt for p, tt in _A6_PRIME_PATTERNS if p.search(t)), None) for t in texts],
        dtype=object,
    )
    fired = prime_fires
    prime_precision = (
        float(np.mean([prime_pred[i] == rows[i]["label"] for i in np.where(fired)[0]]))
        if fired.any()
        else float("nan")
    )

    # Sanity: denying EVERY class must reproduce A2 exactly (the head can never commit), and
    # denying nothing must reproduce A3b. Either failing means the wrapper is mis-wired.
    p_deny_all = run_deny(frozenset(classes))
    p_deny_none = run_deny(frozenset())
    sanity = {
        "deny_all_equals_A2": bool((p_deny_all == p_a2).all()),
        "deny_none_equals_A3b": bool((p_deny_none == p_a3b).all()),
    }
    assert sanity["deny_all_equals_A2"], "deny-all does not reproduce A2 — wrapper mis-wired"
    assert sanity["deny_none_equals_A3b"], "deny-none does not reproduce A3b — wrapper mis-wired"

    # Leave-one-IN: deny everything except class c, so the head decides only when it predicts
    # c. This is the system-level version of the per-class F1 table that motivated A6 — and the
    # two disagree, because per-class F1 does not compose: a class the head has high F1 on can
    # still cost the system, via the false positives it sprays into every other class.
    #
    # It also exposes why a deny set chosen from per-class F1 is structurally blind: classes
    # with NO gold on this set (code, rag, tool_use, other) have no F1 to compare, so they are
    # never denied — yet those are exactly where the head's false positives land.
    a2_test = _macro(gold[~is_val], p_a2[~is_val], test_present, k)
    a2_val = _macro(gold[is_val], p_a2[is_val], val_present, k)
    leave_one_in, leave_one_in_val = {}, {}
    for c in classes:
        pred = run_deny(frozenset(classes) - {c})
        m_test = _macro(gold[~is_val], pred[~is_val], test_present, k)
        m_val = _macro(gold[is_val], pred[is_val], val_present, k)
        leave_one_in[c] = {"held_out_macro_f1": m_test, "delta_vs_A2": m_test - a2_test}
        leave_one_in_val[c] = m_val - a2_val

    # A6-greedy: the fairest possible test of "route, don't replace". Keep exactly the classes
    # whose system-level contribution is positive ON THE VALIDATION HALF, deny everything else,
    # score once on held-out. If even this loses to A2, no class-routing policy rescues the head.
    keep_greedy = frozenset(c for c, d in leave_one_in_val.items() if d > 0)
    deny_greedy = frozenset(classes) - keep_greedy
    p_a6_greedy = run_deny(deny_greedy)

    test = ~is_val
    present = test_present
    arms_out = {}
    for name, pred in (
        ("A2", p_a2), ("A3b", p_a3b), ("A6", p_a6),
        ("A6_fixed", p_a6_fixed), ("A6_oracle", p_a6_oracle),
        ("A6_prime_a", p_a6_prime_a), ("A6_prime_b", p_a6_prime_b),
        ("A6_greedy", p_a6_greedy),
    ):
        arms_out[name] = {
            "held_out_macro_f1": _macro(gold[test], pred[test], present, k),
            "held_out_accuracy": float((pred[test] == gold[test]).mean()),
            "per_class_f1": {
                classes[c]: v for c, v in _per_class_f1(gold[test], pred[test], present, k).items()
            },
        }

    comparisons = {}
    for name, pred in (
        ("A6", p_a6), ("A6_fixed", p_a6_fixed), ("A6_oracle", p_a6_oracle),
        ("A6_prime_a", p_a6_prime_a), ("A6_prime_b", p_a6_prime_b),
        ("A6_greedy", p_a6_greedy), ("A3b", p_a3b),
    ):
        d = _paired_bootstrap(gold[test], pred[test], p_a2[test], present, k)
        comparisons[f"{name}-A2"] = {
            "delta_macro_f1": arms_out[name]["held_out_macro_f1"]
            - arms_out["A2"]["held_out_macro_f1"],
            "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
            "p_gt_0": float((d > 0).mean()),
        }

    out = {
        "prereg": "scripts/eval/classifier_ab/PREREG-A6.md @ 0b3e422",
        "n_total": len(rows),
        "n_tasks": len(tasks),
        "n_validation": int(is_val.sum()),
        "n_held_out": int(test.sum()),
        "deny_set_selected_on_validation": sorted(deny),
        "deny_set_fixed_from_full_set_table": sorted(deny_fixed),
        "deny_set_oracle_selected_on_held_out": sorted(deny_oracle),
        "validation_per_class_f1": {
            classes[c]: {"head": f1_head_val[c], "regex": f1_regex_val[c]} for c in val_present
        },
        "a6_prime": {
            "fire_rate_full_set": float(prime_fires.mean()),
            "fires_n": int(prime_fires.sum()),
            "precision_when_fired": prime_precision,
        },
        "sanity": sanity,
        "leave_one_in_held_out": leave_one_in,
        "leave_one_in_validation_delta": leave_one_in_val,
        "a6_greedy_keep_set_from_validation": sorted(keep_greedy),
        "arms_held_out": arms_out,
        "comparisons_vs_A2_held_out": comparisons,
    }
    args.out.write_text(json.dumps(out, indent=1))

    print(f"n={len(rows)} over {len(tasks)} tasks | validation {is_val.sum()} / held-out {test.sum()}")
    print(f"\ndeny set selected on VALIDATION: {sorted(deny)}")
    print(f"deny set fixed (full-set table):  {sorted(deny_fixed)}")
    print(f"deny set ORACLE (held-out):       {sorted(deny_oracle)}")
    print(f"\nA6' vocabulary patterns: fire on {prime_fires.sum()}/{len(rows)} "
          f"({prime_fires.mean():.2%}), precision when fired {prime_precision:.3f}")
    print(f"sanity: deny-all==A2 {sanity['deny_all_equals_A2']} | "
          f"deny-none==A3b {sanity['deny_none_equals_A3b']}")
    print(f"\n{'arm':12} {'macroF1':>9} {'acc':>7}   delta vs A2 (95% CI, P>0)")
    for name in ("A2", "A3b", "A6", "A6_fixed", "A6_oracle", "A6_prime_a", "A6_prime_b", "A6_greedy"):
        a = arms_out[name]
        c = comparisons.get(f"{name}-A2")
        tail = (
            f"   {c['delta_macro_f1']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}] "
            f"P={c['p_gt_0']:.3f}"
            if c else ""
        )
        print(f"{name:12} {a['held_out_macro_f1']:>9.4f} {a['held_out_accuracy']:>7.3f}{tail}")
    print(f"\nA6-greedy keeps (selected on validation): {sorted(keep_greedy)}")
    print("\nleave-one-IN (head decides ONLY when it predicts this class; rest -> regex):")
    for c, v in sorted(leave_one_in.items(), key=lambda kv: -kv[1]["delta_vs_A2"]):
        if v["delta_vs_A2"] == 0.0:
            continue
        print(f"  keep {c:16} macroF1 {v['held_out_macro_f1']:.4f}  delta vs A2 {v['delta_vs_A2']:+.4f}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
