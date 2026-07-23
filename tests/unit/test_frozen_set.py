"""Classifier program PR-6: integrity pins for the frozen eval set — hermetic, runs in
make test. The set's labels are the adjudicated judgment calls (see
tests/eval/test_classifier_gates.py docstring); training seeds must never leak in."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from minima.schemas.common import TaskType

_ROOT = Path(__file__).resolve().parents[2]
_FROZEN = _ROOT / "tests" / "eval" / "data" / "classifier_frozen_set.jsonl"

sys.path.insert(0, str(_ROOT / "scripts" / "classifier"))


def _rows():
    return [json.loads(line) for line in _FROZEN.open()]


def test_labels_and_slices_are_valid():
    valid = {t.value for t in TaskType}
    rows = _rows()
    assert rows, "frozen set is empty"
    for r in rows:
        assert r["label"] in valid, r
        assert r["slice"] in {"typed", "conversational", "pin", "oos"}, r


def test_no_duplicates():
    texts = [r["text"].lower().strip() for r in _rows()]
    assert len(set(texts)) == len(texts)


def test_every_task_type_covered_in_typed_slice():
    typed = {r["label"] for r in _rows() if r["slice"] == "typed"}
    assert typed == {t.value for t in TaskType}


def test_disjoint_from_training_seeds():
    from seeds import SEEDS

    seed_texts = {t.lower().strip() for texts in SEEDS.values() for t in texts}
    frozen_texts = {r["text"].lower().strip() for r in _rows()}
    leaked = seed_texts & frozen_texts
    assert not leaked, f"training seeds leaked into the frozen eval set: {sorted(leaked)[:5]}"


def test_pins_match_the_regression_suite_expectations():
    pins = {r["text"]: r["label"] for r in _rows() if r["slice"] == "pin"}
    assert pins["build me a website for my bakery"] == "code"
    assert pins["What is the capital of France?"] == "qa"
    assert pins["TL;DR of the meeting notes please"] == "summarization"
