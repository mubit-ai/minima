"""Classifier program PR-6 — the G1 gate suite over the frozen eval set, plus G2.

Runs against the in-repo artifact by default (override with MINIMA_CLASSIFIER_ARTIFACT);
skipped only when neither is present. These gates are hermetic, need no network, and cost
~0.3 s, so they carry NO `eval` marker — they run in the default CI job. They previously sat
behind `-m eval`, which `.github/workflows/ci.yml` excludes, so the suite had never actually
run in CI. Seven green gates on a head that loses 8.7 macro-F1 out-of-corpus (see G2) is what
that gap bought.

Label judgment calls baked into the frozen set (documented here, adjudicated 2026-07-23):
tool_use = "perform an action in an external system", so text-only list generation ("make me
a packing list") is other/creative; explanation-imperatives are qa; rewrite/draft/tone work is
creative; comparison/advice analysis is reasoning.

Gates:
  G1a  macro-F1 >= 0.80 on the typed slice
  G1b  conversational sink-leakage <= 0.15 among non-other-gold rows (regex ~0.77)
  G1c  live-misroute pins: zero regressions
  G1d  true-OOS caught (other | abstain) >= 0.70
  G1e  false-abstain <= alpha + 0.03 on the typed slice
  G1f  p50 latency <= 5 ms
  G1g  beats the VOCABULARY+REGEX baseline macro-F1 on the same rows
  G2   beats vocabulary+regex OUT OF CORPUS (paired bootstrap CI excludes zero)
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_DEFAULT_ARTIFACT = _REPO / "models" / "classifier" / "potion-base-32M-c18e819c6c6d"
_ARTIFACT = os.environ.get("MINIMA_CLASSIFIER_ARTIFACT") or (
    str(_DEFAULT_ARTIFACT) if _DEFAULT_ARTIFACT.is_dir() else ""
)
_FROZEN = Path(__file__).parent / "data" / "classifier_frozen_set.jsonl"

# Out-of-corpus set for G2: Super-NaturalInstructions, 2609 rows over 471 tasks, gold from
# the benchmark authors' Categories via the frozen 76->11 map. Pinned by content hash so the
# gate cannot be made to pass by editing its own eval set. NOT truncated: the head stops at
# 4096 chars (classify_embed.py:23) but the regex tiers scan the whole string, and truncating
# flips 9 of 2609 baseline predictions.
_SNI = Path(__file__).parent / "data" / "classifier_sni_set.jsonl"
_SNI_SHA256 = "9c565a05cc636e68a2f34a4996f078eb6af37c8125935fbda7fc624b14d2e9c9"

# The measured out-of-corpus deficit, from the pre-registered A/B (2026-07-27, n=2609).
# G2 is a strict xfail carrying these numbers: the suite stays green, the defect cannot be
# quietly deleted, and a retrain that fixes it XPASSes and forces this marker's removal.
_G2_MEASURED_DELTA = -0.0865
_G2_MEASURED_CI = (-0.1075, -0.0653)

_BOOTSTRAP = 10_000
_SEED = 20260727


@pytest.fixture(scope="module")
def rows():
    return [json.loads(line) for line in _FROZEN.open()]


@pytest.fixture(scope="module")
def head():
    if not _ARTIFACT:
        pytest.skip("no classifier artifact — set MINIMA_CLASSIFIER_ARTIFACT")
    from minima.recommender.classify_embed import load_embed_classifier

    classifier = load_embed_classifier(_ARTIFACT, required=True)
    assert classifier is not None
    return classifier


def _serving(embed):
    """The serving path itself, not a mirror of it: `classify_details` with `embed` injected
    is exactly how `Recommender(embed_classifier=...)` wires the tier ladder. The previous
    fixture hand-copied that ladder, which could drift from the dispatcher silently and whose
    `classify(self, text)` signature was not substitutable for EmbedClassifier."""
    from minima.recommender.classify import classify_details
    from minima.schemas.common import TaskInput

    class Serving:
        def classify(self, text: str):
            return classify_details(TaskInput(task=text), embed=embed)

    return Serving()


class _AlwaysAbstain:
    """The vocabulary tier still runs, the head never commits, and the dispatcher falls
    through to the regex — so this yields `vocabulary + regex` through the genuine code path
    with no logic copied out of src/. Same construction as the A2 arm of the A/B."""

    classifier_id = "stub-abstain"

    def classify(self, text: str, regex_hint=None):
        from minima.recommender.classify_embed import EmbedResult
        from minima.schemas.common import TaskType

        return EmbedResult(TaskType.other, 0.0, True)


@pytest.fixture(scope="module")
def clf(head):
    return _serving(head)


@pytest.fixture(scope="module")
def baseline(head):
    """G1g/G2's control. The old baseline was bare `infer_task_type`, so it credited the
    vocabulary tier's wins to the head — it measured (vocab+head) - regex, not the head's own
    contribution over the stack it replaces."""
    return _serving(_AlwaysAbstain())


def _slice(rows, name):
    return [r for r in rows if r["slice"] == name]


def _macro_f1(gold: list[str], pred: list[str]) -> float:
    labels = sorted(set(gold) | set(pred))
    scores = []
    for lab in labels:
        tp = sum(1 for g, p in zip(gold, pred, strict=True) if g == lab and p == lab)
        fp = sum(1 for g, p in zip(gold, pred, strict=True) if g != lab and p == lab)
        fn = sum(1 for g, p in zip(gold, pred, strict=True) if g == lab and p != lab)
        denom = 2 * tp + fp + fn
        scores.append(2 * tp / denom if denom else 0.0)
    return sum(scores) / len(scores)


def test_g1a_macro_f1_on_typed(clf, rows):
    typed = _slice(rows, "typed")
    preds = [clf.classify(r["text"]).task_type.value for r in typed]
    macro = _macro_f1([r["label"] for r in typed], preds)
    assert macro >= 0.80, f"macro-F1 {macro:.3f} below the 0.80 gate"


def test_g1b_conversational_sink_leakage(clf, rows):
    # Sink leakage: conversational rows whose gold label is NOT other, but the head
    # sends to other anyway. (Rows gold-labeled other — roleplay, packing lists — are
    # excluded from the denominator: predicting them other is CORRECT, and counting
    # them made the old rate unpassable by construction.) Regex baseline: ~0.77.
    conv = [r for r in _slice(rows, "conversational") if r["label"] != "other"]
    leaked = sum(1 for r in conv if clf.classify(r["text"]).task_type.value == "other")
    rate = leaked / len(conv)
    assert rate <= 0.15, f"conversational sink-leakage {rate:.2f} above the 0.15 gate"


def test_g1c_misroute_pins_zero_regressions(clf, rows):
    misses = [
        (r["text"], r["label"], got.task_type.value)
        for r in _slice(rows, "pin")
        if (got := clf.classify(r["text"])).task_type.value != r["label"] and not got.abstained
    ]
    assert not misses, f"pin regressions (non-abstained misassignments): {misses}"


def test_g1d_true_oos_caught(clf, rows):
    oos = _slice(rows, "oos")
    caught = sum(
        1
        for r in oos
        if (res := clf.classify(r["text"])).task_type.value == "other" or res.abstained
    )
    assert caught / len(oos) >= 0.70, f"true-OOS caught {caught}/{len(oos)} below 0.70"


def test_g1e_false_abstain_bounded(clf, rows):
    typed = _slice(rows, "typed")
    abstain = sum(1 for r in typed if clf.classify(r["text"]).abstained)
    rate = abstain / len(typed)
    assert rate <= 0.08, f"false-abstain {rate:.3f} above alpha + slack (0.08)"


def test_g1f_latency(clf, rows):
    texts = [r["text"] for r in rows]
    t0 = time.time()
    for t in texts:
        clf.classify(t)
    per = (time.time() - t0) / len(texts) * 1000
    assert per <= 5.0, f"{per:.2f} ms/prompt above the 5 ms gate"


def test_g1g_beats_vocab_plus_regex_baseline(clf, baseline, rows):
    scored = [r for r in rows if r["slice"] in ("typed", "conversational")]
    gold = [r["label"] for r in scored]
    head = _macro_f1(gold, [clf.classify(r["text"]).task_type.value for r in scored])
    base = _macro_f1(gold, [baseline.classify(r["text"]).task_type.value for r in scored])
    assert head > base, f"head macro-F1 {head:.3f} does not beat vocab+regex {base:.3f}"


def test_g2_eval_set_is_the_frozen_one():
    """G2 asserts a comparison; this asserts G2 is comparing on the set it claims to."""
    if not _SNI.exists():
        pytest.skip("SNI out-of-corpus set not present")
    got = hashlib.sha256(_SNI.read_bytes()).hexdigest()
    assert got == _SNI_SHA256, f"SNI gate set changed: {got}"


@pytest.mark.xfail(
    strict=True,
    reason=(
        f"Measured 2026-07-27 (n=2609): the head loses to vocabulary+regex out of corpus, "
        f"delta={_G2_MEASURED_DELTA:+.4f} macro-F1, 95% CI {_G2_MEASURED_CI}. In-corpus gates "
        f"G1a-G1g all pass, so this is the only gate that sees it. When a retrained artifact "
        f"fixes it this XPASSes — delete the marker then, do not relax the gate."
    ),
)
def test_g2_beats_vocab_plus_regex_out_of_corpus(clf, baseline):
    """Out-of-corpus paired comparison on Super-NaturalInstructions.

    Macro-F1 over the gold-PRESENT classes (a class absent from gold contributes no row to
    recall, so including it would score noise), paired bootstrap over PROMPTS so both arms
    resample together. Same estimator, seed, and draw count as the pre-registered A/B, so the
    number here is directly comparable to the one in its report.
    """
    import numpy as np

    if not _SNI.exists():
        pytest.skip("SNI out-of-corpus set not present")
    from minima.schemas.common import TaskType

    sni = [json.loads(line) for line in _SNI.open()]
    classes = [t.value for t in TaskType]
    cidx = {c: i for i, c in enumerate(classes)}
    k = len(classes)

    gold = np.array([cidx[r["label"]] for r in sni])
    p_head = np.array([cidx[clf.classify(r["text"]).task_type.value] for r in sni])
    p_base = np.array([cidx[baseline.classify(r["text"]).task_type.value] for r in sni])
    present = np.unique(gold)

    def macro(counts):
        conf = counts.reshape(k, k)
        tp = np.diag(conf).astype(np.float64)
        fp = conf.sum(axis=0) - tp
        fn = conf.sum(axis=1) - tp
        denom = 2 * tp + fp + fn
        f1 = np.divide(2 * tp, denom, out=np.zeros_like(denom), where=denom > 0)
        return float(f1[present].mean())

    ch, cb = gold * k + p_head, gold * k + p_base
    rng = np.random.default_rng(_SEED)
    m = len(gold)
    deltas = np.empty(_BOOTSTRAP)
    for i in range(_BOOTSTRAP):
        idx = rng.integers(0, m, m)
        deltas[i] = macro(np.bincount(ch[idx], minlength=k * k)) - macro(
            np.bincount(cb[idx], minlength=k * k)
        )
    lo, hi = float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))
    delta = macro(np.bincount(ch, minlength=k * k)) - macro(np.bincount(cb, minlength=k * k))

    assert lo > 0, (
        f"head does not beat vocabulary+regex out of corpus: "
        f"delta={delta:+.4f} macro-F1, 95% CI [{lo:+.4f}, {hi:+.4f}], n={m}"
    )
