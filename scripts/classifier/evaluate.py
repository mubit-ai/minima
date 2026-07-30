# /// script
# requires-python = ">=3.11"
# dependencies = ["model2vec>=0.5", "scikit-learn>=1.4", "numpy>=1.26"]
# ///
"""G1-style evaluation of a trained artifact: held-out macro-F1, misroute pins,
Minima-scoped true-OOS, false-abstain, latency — plus the regex baseline when run
inside the repo (`uv run --project . scripts/classifier/evaluate.py`).

Gates (docs: classifier-redesign research, eval gate G1):
  macro-F1 >= 0.80 · pins: zero regressions · false-abstain <= ~alpha ·
  true-OOS caught >= 0.70 · p50 latency <= 5 ms
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from common import TRUE_OOS_EVAL

# The live-misroute regression pins (tests/unit/test_classify_keys.py) — the prompts that
# actually misrouted in production. Zero regressions is a hard gate.
PINS = (
    (
        "There is a failing test in this project. Run the tests with: python3 -m pytest -q, "
        "find the bug, fix it, and re-run the tests to confirm they all pass. "
        "Then summarize the fix in one sentence.",
        "code",
    ),
    (
        "Design a lock-free concurrent LRU cache eviction strategy for a multi-tenant "
        "inference gateway where tenants have different SLAs. Explain the memory-ordering "
        "constraints and the ABA-problem mitigation in under 150 words.",
        "reasoning",
    ),
    ("Summarize this article in three sentences.", "summarization"),
    ("TL;DR of the meeting notes please", "summarization"),
    ("Fix the bug in stats.py so the tests pass", "code"),
    ("Why does src/main.rs not compile?", "code"),
    ("Summarize what utils.py does, refactor notes welcome", "code"),
    ("What is the capital of France?", "qa"),
    ("build me a website for my bakery", "code"),
    ("fix my landing page, the layout is broken", "code"),
    ("fix our checkout flow bug", "code"),
    ("tweak styles.css so the header sticks", "code"),
    ("update index.html with the new nav", "code"),
    ("create a landing page for the product launch", "code"),
    ("add some html and css for the hero section", "code"),
    # agentic tool_use/code boundary pins (2026-07-30) — mirrored in the frozen set.
    ("open a pull request for this branch and request review", "tool_use"),
    ("create a github issue for the flaky auth test and attach the log", "tool_use"),
    ("run the linter and fix everything it flags", "code"),
)


class ArtifactClassifier:
    """The shipped inference path: numpy + tokenizers only, int8 embeddings."""

    def __init__(self, artifact: Path):
        from tokenizers import Tokenizer

        emb = np.load(artifact / "embeddings.npz")
        self.E = emb["q"].astype(np.float32) * emb["scales"][:, None]
        head = np.load(artifact / "head.npz", allow_pickle=False)
        self.coef = head["coef"]
        self.intercept = head["intercept"]
        self.anchors = head["anchors"]
        self.classes = [str(c) for c in head["classes"]]
        self.tau_dist = float(head["tau_dist"])
        self.tau_margin = float(head["tau_margin"])
        self.tok = Tokenizer.from_file(str(artifact / "tokenizer.json"))
        self.manifest = json.loads((artifact / "manifest.json").read_text())
        # Regex-as-feature mirror (classify_embed.py): one-hot of the regex vote rides
        # next to the embedding. Standalone runs (no repo venv) classify with no hint —
        # same as serving with regex_hint=None.
        self.regex_classes = (
            [str(c) for c in head["regex_classes"]] if "regex_classes" in head else []
        )
        self.regex_scale = float(head["regex_scale"]) if "regex_scale" in head else 1.0
        try:
            from minima.recommender.classify import infer_task_type

            self._hint = lambda text: infer_task_type(text).value
        except ImportError:
            self._hint = lambda text: None

    def classify(self, text: str) -> tuple[str, bool]:
        ids = self.tok.encode(text, add_special_tokens=False).ids
        v = self.E[ids].mean(axis=0) if ids else np.zeros(self.E.shape[1], dtype=np.float32)
        v = v / max(float(np.linalg.norm(v)), 1e-9)
        feats = v
        if self.regex_classes:
            onehot = np.zeros(len(self.regex_classes), dtype=np.float32)
            hint = self._hint(text)
            if hint in self.regex_classes:
                onehot[self.regex_classes.index(hint)] = self.regex_scale
            feats = np.concatenate([v, onehot])
        logits = self.coef @ feats + self.intercept
        p = np.exp(logits - logits.max())
        p /= p.sum()
        order = np.argsort(p)
        margin = float(p[order[-1]] - p[order[-2]])
        dist = 1.0 - float((self.anchors @ v).max())
        abstain = dist > self.tau_dist or margin < self.tau_margin
        return self.classes[int(order[-1])], abstain


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifact", type=Path, default=Path("artifact"))
    ap.add_argument("--corpus", type=Path, default=Path("corpus.jsonl"))
    ap.add_argument("--report", type=Path, default=Path("train_report.json"))
    args = ap.parse_args()

    from sklearn.metrics import classification_report, f1_score

    clf = ArtifactClassifier(args.artifact)
    print("evaluating", clf.manifest["classifier_id"])

    rows = [json.loads(line) for line in args.corpus.open()]
    te = json.loads(args.report.read_text())["test_indices"]
    texts = [rows[i]["text"] for i in te]
    gold = [rows[i]["label"] for i in te]
    preds, abstains = zip(*(clf.classify(t) for t in texts), strict=True)
    print(classification_report(gold, list(preds), digits=3))
    macro = f1_score(gold, list(preds), average="macro")
    fa = sum(abstains) / len(abstains)
    print(f"macro-F1 {macro:.3f} (gate >= 0.80) | false-abstain {fa:.3f} (gate <= ~alpha)")

    pin_preds = [clf.classify(t)[0] for t, _ in PINS]
    misses = [(t, w, p) for (t, w), p in zip(PINS, pin_preds, strict=True) if p != w]
    print(f"misroute pins: {len(PINS) - len(misses)}/{len(PINS)} (gate: zero regressions)")
    for t, w, p in misses:
        print(f"  MISS [{p}] wanted {w}: {t[:70]}")

    oos_hits = sum(1 for t in TRUE_OOS_EVAL if (r := clf.classify(t))[0] == "other" or r[1])
    print(f"true-OOS caught: {oos_hits}/{len(TRUE_OOS_EVAL)} (gate >= 0.70)")

    t0 = time.time()
    for t in texts[:200]:
        clf.classify(t)
    print(f"latency: {(time.time() - t0) / 200 * 1000:.2f} ms/prompt (gate p50 <= 5 ms)")

    try:
        from minima.recommender.classify import infer_task_type

        regex_preds = [infer_task_type(t).value for t in texts]
        print(f"regex baseline macro-F1 {f1_score(gold, regex_preds, average='macro'):.3f}")
    except ImportError:
        print("regex baseline skipped (run inside the repo venv for the comparison)")


if __name__ == "__main__":
    main()
