"""Classifier program PR-6 — the G1 gate suite over the frozen eval set.

Runs in CI against the committed artifact under models/classifier/ (the one the Docker
image bakes), so a re-train that regresses quality — even a self-consistent one that
still passes the content-hash check in test_committed_artifact.py — turns a gate red on
the PR instead of shipping silently. Point MINIMA_CLASSIFIER_ARTIFACT at a candidate to
gate it during a re-train:
  MINIMA_CLASSIFIER_ARTIFACT=<dir> uv run pytest tests/eval/test_classifier_gates.py

The quality gates are deterministic (numpy matmul over frozen rows) and run every PR;
only the latency gate (G1f) is eval-marked, since ms/prompt is a property of the runner
hardware, not the artifact, and would flake on shared CI runners.

Label judgment calls baked into the frozen set (documented here, adjudicated
2026-07-23): tool_use = "perform an action in an external system", so text-only list
generation ("make me a packing list") is other/creative; explanation-imperatives are
qa; rewrite/draft/tone work is creative; comparison/advice analysis is reasoning.

Gates:
  G1a  macro-F1 >= 0.80 on the typed slice
  G1b  conversational sink-leakage <= 0.15 among non-other-gold rows (regex ~0.77)
  G1c  live-misroute pins: zero regressions
  G1d  true-OOS caught (other | abstain) >= 0.70
  G1e  false-abstain <= alpha + 0.03 on the typed slice
  G1f  p50 latency <= 5 ms  (eval-only — hardware-dependent)
  G1g  beats the regex baseline macro-F1 on the same rows
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

_FROZEN = Path(__file__).parent / "data" / "classifier_frozen_set.jsonl"
_COMMITTED = Path(__file__).resolve().parents[2] / "models" / "classifier"


def _artifact_dir() -> str:
    """The env override (a re-train candidate) wins; otherwise the single committed
    bundle. No skip: the committed artifact is git-tracked and the [classifier] extra
    rides in `dev`, so a missing artifact is a real failure, not a reason to go green."""
    env = os.environ.get("MINIMA_CLASSIFIER_ARTIFACT", "")
    if env:
        return env
    matches = sorted(p.parent for p in _COMMITTED.glob("*/manifest.json"))
    assert len(matches) == 1, f"expected exactly one committed artifact, found {matches}"
    return str(matches[0])


@pytest.fixture(scope="module")
def rows():
    return [json.loads(line) for line in _FROZEN.open()]


@pytest.fixture(scope="module")
def clf():
    from minima.recommender.classify import high_precision_type, infer_task_type
    from minima.recommender.classify_embed import EmbedResult, load_embed_classifier

    classifier = load_embed_classifier(_artifact_dir(), required=True)
    assert classifier is not None

    class Serving:
        """Mirror of classify_details' tiered dispatch: vocabulary short-circuits,
        then the head (with the regex hint), regex on abstain via the dispatcher."""

        classifier_id = classifier.classifier_id

        def classify(self, text):
            precise = high_precision_type(text)
            if precise is not None:
                return EmbedResult(precise, 1.0, False)
            return classifier.classify(text, regex_hint=infer_task_type(text))

    return Serving()


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


@pytest.mark.eval
def test_g1f_latency(clf, rows):
    import time

    texts = [r["text"] for r in rows]
    t0 = time.time()
    for t in texts:
        clf.classify(t)
    per = (time.time() - t0) / len(texts) * 1000
    assert per <= 5.0, f"{per:.2f} ms/prompt above the 5 ms gate"


def test_g1g_beats_regex_baseline(clf, rows):
    from minima.recommender.classify import infer_task_type

    scored = [r for r in rows if r["slice"] in ("typed", "conversational")]
    gold = [r["label"] for r in scored]
    head = _macro_f1(gold, [clf.classify(r["text"]).task_type.value for r in scored])
    regex = _macro_f1(gold, [infer_task_type(r["text"]).value for r in scored])
    assert head > regex, f"head macro-F1 {head:.3f} does not beat regex {regex:.3f}"
